import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { AppError, requireId, requireText } from './types.ts';

const MINUTE = 60_000, DAY = 86_400_000;
export const SCHEDULE_LIMITS = { perBot: 100, total: 1000, firesPerTick: 100, historyPage: 100 } as const;
export const SCHEDULE_POLICY = {
  missed: 'coalesce_once', overlap: 'skip', dstGap: 'skip', dstFold: 'first', paused: 'skip',
} as const;
export type ScheduleInput = {
  name: string; prompt: string; requestId?: string;
} & ({ kind: 'once'; runAt: number; timeZone?: string } | { kind: 'cron'; cron: string; timeZone: string });
export interface Schedule {
  id: string; botId: string; name: string; prompt: string; kind: 'once' | 'cron';
  cron: string | null; timeZone: string; runAt: number | null;
  state: 'active' | 'paused' | 'completed' | 'deleted'; nextRunAt: number | null;
  lastFireAt: number | null; lastTaskId: string | null; createdAt: number; updatedAt: number;
}
export interface ScheduleFire {
  scheduleId: string; botId: string; scheduledAt: number; observedAt: number;
  requestId: string; taskId: string | null; outcome: 'queued' | 'skipped_overlap'; coalesced: boolean;
}
type FireRow = Omit<ScheduleFire, 'coalesced'> & { coalesced: number };
type CronField = { values: number[]; set: Set<number>; wildcard: boolean };
type Cron = { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField };
type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    if (typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) throw new AppError(400, 'Use an IANA time zone, such as Asia/Shanghai or UTC');
    try { value = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch { throw new AppError(400, 'Invalid IANA time zone'); }
    // A bounded cache: schedule inputs cannot grow process memory without limit.
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, value);
  }
  return value;
}
function civil(at: number, zone: Intl.DateTimeFormat): Civil {
  const parts = Object.fromEntries(zone.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}
function epoch(c: Civil) { return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second); }
function timestamp(value: unknown, label: string): asserts value is number {
  // Restrict to the modern Gregorian epoch; Date.UTC treats years 0–99 specially.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Date.UTC(9990, 0, 1)) throw new AppError(400, `${label} must be an epoch-millisecond timestamp between years 1970 and 9990`);
}
function field(text: string, min: number, max: number, sunday = false): CronField {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new AppError(400, 'Invalid cron field');
    const base = match[1]!, step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new AppError(400, 'Invalid cron step');
    const range = base === '*' ? [min, max] : base.split('-').map(Number);
    const start = range[0]!, end = range[1] ?? (match[2] ? max : start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new AppError(400, 'Cron field is out of range');
    for (let n = start; n <= end; n += step) values.add(sunday && n === 7 ? 0 : n);
  }
  return { values: [...values].sort((a, b) => a - b), set: values, wildcard: text === '*' };
}
function parseCron(expression: string): Cron {
  if (typeof expression !== 'string' || expression.length > 128) throw new AppError(400, 'Cron must be a five-field expression of at most 128 characters');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new AppError(400, 'Cron requires five fields: minute hour day month weekday');
  return { minute: field(fields[0]!, 0, 59), hour: field(fields[1]!, 0, 23), day: field(fields[2]!, 1, 31), month: field(fields[3]!, 1, 12), weekday: field(fields[4]!, 0, 7, true) };
}
function matchingDay(date: Date, cron: Cron) {
  if (!cron.month.set.has(date.getUTCMonth() + 1)) return false;
  const day = cron.day.set.has(date.getUTCDate()), weekday = cron.weekday.set.has(date.getUTCDay());
  return cron.day.wildcard ? weekday : cron.weekday.wildcard ? day : day || weekday;
}
/** Strictly after `after`. Gaps are skipped; a folded local minute fires only once, at its first instant. */
export function nextCronRun(expression: string, timeZone: string, after: number): number {
  timestamp(after, 'Current time');
  const cron = parseCron(expression), zone = formatter(timeZone), local = civil(after, zone);
  const firstDay = Date.UTC(local.year, local.month - 1, local.day) - DAY;
  let best = Infinity;
  // Eight years covers February 29 across a non-leap century. Never minute-scan an outage.
  for (let d = 0; d <= 366 * 8 + 3; d++) {
    const dayStart = firstDay + d * DAY;
    if (dayStart > best + 2 * DAY) break;
    const date = new Date(dayStart);
    if (!matchingDay(date, cron)) continue;
    // Discover the offsets on either side of transitions, including 30-minute changes
    // and date-line skips. Every candidate is round-tripped through ICU, not guessed.
    const offsets = new Set<number>();
    for (let h = -48; h <= 48; h += 6) {
      const sample = dayStart + h * 60 * MINUTE;
      offsets.add(epoch(civil(sample, zone)) - sample);
    }
    const minOffset = Math.min(...offsets), maxOffset = Math.max(...offsets);
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const wall = dayStart + hour * 60 * MINUTE + minute * MINUTE;
      if (wall - minOffset <= after || wall - maxOffset >= best) continue;
      const candidates: number[] = [];
      for (const offset of offsets) {
        const instant = wall - offset;
        // Do not exclude past instants here: the first half of a fold must suppress its second half.
        if (instant >= best) continue;
        const actual = civil(instant, zone);
        if (epoch(actual) === wall) candidates.push(instant);
      }
      const first = Math.min(...candidates);
      if (first > after && first < best) best = first;
    }
  }
  if (!Number.isFinite(best)) throw new AppError(400, 'Cron has no occurrence within eight years');
  return best;
}
function validate(input: ScheduleInput, now: number) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid schedule');
  requireText(input.name, 80); requireText(input.prompt);
  if (input.requestId !== undefined) requireId(input.requestId);
  const timeZone = input.timeZone ?? (input.kind === 'once' ? 'UTC' : undefined);
  formatter(timeZone!);
  if (input.kind === 'once') {
    timestamp(input.runAt, 'Run time');
    if (input.runAt <= now) throw new AppError(400, 'A one-time schedule must be in the future');
    return { name: input.name.trim(), prompt: input.prompt, kind: 'once' as const, cron: null, timeZone: timeZone!, runAt: input.runAt, nextRunAt: input.runAt };
  }
  if (input.kind === 'cron') {
    const nextRunAt = nextCronRun(input.cron, timeZone!, now);
    return { name: input.name.trim(), prompt: input.prompt, kind: 'cron' as const, cron: input.cron.trim().replace(/\s+/g, ' '), timeZone: timeZone!, runAt: null, nextRunAt };
  }
  throw new AppError(400, 'Schedule kind must be once or cron');
}
/** UUID-shaped, stable private request namespace accepted by Store.submit. */
export function scheduleRequestId(id: string, scheduledAt: number): string {
  const hex = createHash('sha256').update(`chestnut:schedule:v1:${id}:${scheduledAt}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export class Scheduler {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules(
        id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),name TEXT NOT NULL,prompt TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('once','cron')),cron TEXT,timeZone TEXT NOT NULL,runAt INTEGER,
        state TEXT NOT NULL CHECK(state IN ('active','paused','completed','deleted')),nextRunAt INTEGER,
        lastFireAt INTEGER,lastTaskId TEXT REFERENCES tasks(id),createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state,nextRunAt);
      CREATE INDEX IF NOT EXISTS schedules_bot ON schedules(botId,state);
      CREATE TABLE IF NOT EXISTS schedule_fires(
        scheduleId TEXT NOT NULL REFERENCES schedules(id),botId TEXT NOT NULL REFERENCES bots(id),
        scheduledAt INTEGER NOT NULL,observedAt INTEGER NOT NULL,requestId TEXT NOT NULL UNIQUE,
        taskId TEXT REFERENCES tasks(id),outcome TEXT NOT NULL CHECK(outcome IN ('queued','skipped_overlap')),
        coalesced INTEGER NOT NULL,PRIMARY KEY(scheduleId,scheduledAt)
      );
      CREATE INDEX IF NOT EXISTS schedule_tasks ON schedule_fires(scheduleId,taskId);
      CREATE TABLE IF NOT EXISTS schedule_requests(
        botId TEXT NOT NULL REFERENCES bots(id),requestId TEXT NOT NULL,payload TEXT NOT NULL,
        scheduleId TEXT NOT NULL REFERENCES schedules(id),PRIMARY KEY(botId,requestId)
      );`);
  }
  create(botId: string, input: ScheduleInput, now = Date.now()): Schedule {
    this.store.bot(botId); timestamp(now, 'Current time');
    if (!input || typeof input !== 'object') throw new AppError(400, 'Invalid schedule');
    if (input.requestId !== undefined) requireId(input.requestId);
    // Fixed property order makes transport key order irrelevant to retry identity.
    const payload = JSON.stringify({ name: input.name, prompt: input.prompt, kind: input.kind,
      cron: input.kind === 'cron' ? input.cron : null, runAt: input.kind === 'once' ? input.runAt : null,
      timeZone: input.timeZone ?? (input.kind === 'once' ? 'UTC' : null) });
    return this.store.tx(() => {
      if (input.requestId) {
        const prior = this.store.get<{ payload: string; scheduleId: string }>('SELECT * FROM schedule_requests WHERE botId=? AND requestId=?', botId, input.requestId);
        if (prior) {
          if (prior.payload !== payload) throw new AppError(409, 'Schedule request ID was already used for different content');
          return this.get(botId, prior.scheduleId);
        }
      }
      const value = validate(input, now);
      const own = this.store.get<{ n: number }>("SELECT count(*) n FROM schedules WHERE botId=? AND state IN ('active','paused')", botId)!.n;
      const total = this.store.get<{ n: number }>("SELECT count(*) n FROM schedules WHERE state IN ('active','paused')")!.n;
      if (own >= SCHEDULE_LIMITS.perBot || total >= SCHEDULE_LIMITS.total) throw new AppError(409, 'Schedule limit reached; delete an unused schedule first');
      const schedule: Schedule = { id: randomUUID(), botId, ...value, state: 'active', lastFireAt: null, lastTaskId: null, createdAt: now, updatedAt: now };
      this.store.db.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(schedule.id, botId, schedule.name, schedule.prompt, schedule.kind, schedule.cron, schedule.timeZone, schedule.runAt, schedule.state, schedule.nextRunAt, null, null, now, now);
      if (input.requestId) this.store.db.prepare('INSERT INTO schedule_requests VALUES (?,?,?,?)').run(botId, input.requestId, payload, schedule.id);
      return schedule;
    });
  }
  get(botId: string, id: string): Schedule {
    this.store.bot(botId); requireId(id);
    const schedule = this.store.get<Schedule>('SELECT * FROM schedules WHERE botId=? AND id=?', botId, id);
    if (!schedule) throw new AppError(404, 'Schedule not found for this bot');
    return schedule;
  }
  list(botId: string): Schedule[] {
    this.store.bot(botId);
    return this.store.all<Schedule>("SELECT * FROM schedules WHERE botId=? AND state!='deleted' ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,createdAt DESC,id LIMIT 1000", botId);
  }
  update(botId: string, id: string, input: ScheduleInput, now = Date.now()): Schedule {
    timestamp(now, 'Current time');
    return this.store.tx(() => {
      const existing = this.get(botId, id);
      if (existing.state === 'deleted' || existing.state === 'completed') throw new AppError(409, 'Create a new schedule after completion or deletion');
      const value = validate(input, now);
      this.store.db.prepare('UPDATE schedules SET name=?,prompt=?,kind=?,cron=?,timeZone=?,runAt=?,nextRunAt=?,updatedAt=? WHERE id=?').run(value.name, value.prompt, value.kind, value.cron, value.timeZone, value.runAt, existing.state === 'paused' ? null : value.nextRunAt, now, id);
      return this.get(botId, id);
    });
  }
  pause(botId: string, id: string, now = Date.now()): Schedule {
    timestamp(now, 'Current time');
    return this.store.tx(() => {
      const existing = this.get(botId, id);
      if (existing.state === 'active') this.store.db.prepare("UPDATE schedules SET state='paused',nextRunAt=NULL,updatedAt=? WHERE id=?").run(now, id);
      return this.get(botId, id);
    });
  }
  resume(botId: string, id: string, now = Date.now()): Schedule {
    timestamp(now, 'Current time');
    return this.store.tx(() => {
      const existing = this.get(botId, id);
      if (existing.state === 'deleted' || existing.state === 'completed') throw new AppError(409, 'Create a new schedule after completion or deletion');
      if (existing.state === 'paused') {
        // An explicitly resumed overdue once is eligible now. Cron never backfills its paused interval.
        const next = existing.kind === 'once' ? existing.runAt! : nextCronRun(existing.cron!, existing.timeZone, now);
        this.store.db.prepare("UPDATE schedules SET state='active',nextRunAt=?,updatedAt=? WHERE id=?").run(next, now, id);
      }
      return this.get(botId, id);
    });
  }
  delete(botId: string, id: string, now = Date.now()): Schedule {
    timestamp(now, 'Current time');
    return this.store.tx(() => {
      this.get(botId, id);
      this.store.db.prepare("UPDATE schedules SET state='deleted',nextRunAt=NULL,updatedAt=? WHERE id=?").run(now, id);
      return this.get(botId, id);
    });
  }
  history(botId: string, id: string): ScheduleFire[] {
    this.get(botId, id);
    return this.store.all<FireRow>('SELECT * FROM schedule_fires WHERE botId=? AND scheduleId=? ORDER BY scheduledAt DESC LIMIT ?', botId, id, SCHEDULE_LIMITS.historyPage).map(row => ({ ...row, coalesced: !!row.coalesced }));
  }
  status(botId?: string, now = Date.now()) {
    timestamp(now, 'Current time'); if (botId !== undefined) this.store.bot(botId);
    const where = botId === undefined ? '' : ' WHERE botId=?', args = botId === undefined ? [] : [botId];
    const rows = this.store.all<{ state: Schedule['state']; count: number }>(`SELECT state,count(*) count FROM schedules${where} GROUP BY state`, ...args);
    const counts = { active: 0, paused: 0, completed: 0, deleted: 0 };
    for (const row of rows) counts[row.state] = row.count;
    const activeWhere = `${where}${where ? ' AND' : ' WHERE'} state='active'`;
    const nextRunAt = this.store.get<{ next: number | null }>(`SELECT min(nextRunAt) next FROM schedules${activeWhere}`, ...args)!.next;
    const due = this.store.get<{ count: number }>(`SELECT count(*) count FROM schedules${activeWhere} AND nextRunAt<=?`, ...args, now)!.count;
    return { counts, nextRunAt, due, policy: SCHEDULE_POLICY, limits: SCHEDULE_LIMITS };
  }
  /** Synchronous, bounded and atomic per fire; safe for independent worker processes sharing SQLite. */
  tick(now = Date.now()): ScheduleFire[] {
    timestamp(now, 'Current time');
    const due = this.store.all<{ id: string; botId: string }>("SELECT id,botId FROM schedules WHERE state='active' AND nextRunAt<=? ORDER BY nextRunAt,id LIMIT ?", now, SCHEDULE_LIMITS.firesPerTick);
    const fired: ScheduleFire[] = [];
    for (const item of due) {
      const result = this.store.tx(() => {
        // Re-read after BEGIN IMMEDIATE: another process may already have fired, paused or deleted it.
        const schedule = this.get(item.botId, item.id);
        if(this.store.get("SELECT requestId FROM environment_operations WHERE botId=? AND state IN ('queued','running','uncertain') LIMIT 1",schedule.botId))return null;
        if (schedule.state !== 'active' || schedule.nextRunAt === null || schedule.nextRunAt > now) return null;
        const scheduledAt = schedule.nextRunAt;
        const nextRunAt = schedule.kind === 'cron' ? nextCronRun(schedule.cron!, schedule.timeZone, now) : null;
        const previous = this.store.get('SELECT scheduleId FROM schedule_fires WHERE scheduleId=? AND scheduledAt=?', schedule.id, scheduledAt);
        if (previous) {
          this.store.db.prepare('UPDATE schedules SET state=?,nextRunAt=?,updatedAt=? WHERE id=?').run(schedule.kind === 'once' ? 'completed' : 'active', nextRunAt, now, schedule.id);
          return null;
        }
        const outstanding = this.store.get(`SELECT t.id FROM schedule_fires f JOIN tasks t ON t.id=f.taskId AND t.botId=f.botId WHERE f.scheduleId=? AND t.state IN ('queued','running','cancelling') LIMIT 1`, schedule.id);
        const requestId = scheduleRequestId(schedule.id, scheduledAt);
        const task = outstanding ? null : this.store.submitInTransaction(schedule.botId, requestId, schedule.prompt);
        const coalesced = schedule.kind === 'cron' && nextCronRun(schedule.cron!, schedule.timeZone, scheduledAt) <= now;
        const fire: ScheduleFire = { scheduleId: schedule.id, botId: schedule.botId, scheduledAt, observedAt: now, requestId, taskId: task?.id ?? null, outcome: task ? 'queued' : 'skipped_overlap', coalesced };
        this.store.db.prepare('INSERT INTO schedule_fires VALUES (?,?,?,?,?,?,?,?)').run(schedule.id, schedule.botId, scheduledAt, now, requestId, fire.taskId, fire.outcome, coalesced ? 1 : 0);
        this.store.db.prepare('UPDATE schedules SET state=?,nextRunAt=?,lastFireAt=?,lastTaskId=COALESCE(?,lastTaskId),updatedAt=? WHERE id=?').run(schedule.kind === 'once' ? 'completed' : 'active', nextRunAt, scheduledAt, fire.taskId, now, schedule.id);
        if (task) this.store.event(schedule.botId, task.id, 'schedule.fired', { scheduleId: schedule.id, scheduledAt, observedAt: now, coalesced });
        return fire;
      });
      if (result) fired.push(result);
    }
    return fired;
  }
}
