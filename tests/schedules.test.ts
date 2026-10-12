import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/store.ts';
import { Scheduler, nextCronRun, SCHEDULE_LIMITS, scheduleRequestId, type ScheduleInput } from '../src/schedules.ts';

const start = Date.parse('2026-10-12T12:00:00Z'), minute = 60_000;
const cron: ScheduleInput = { name: 'Check inbox', prompt: 'Summarize the next task', kind: 'cron', cron: '* * * * *', timeZone: 'UTC' };
function fixture() { const store = new Store(':memory:'), bot = store.createBot('Chestnut'), scheduler = new Scheduler(store); return { store, bot, scheduler }; }
function once(runAt = start + minute): ScheduleInput { return { name: 'Reminder', prompt: 'Review the pending proposal', kind: 'once', runAt }; }
function next(expression: string, zone: string, after: string) { return new Date(nextCronRun(expression, zone, Date.parse(after))).toISOString(); }

test('once persists one queue admission, fire ledger and outbox together across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chestnut-schedules-')), path = join(dir, 'db.sqlite');
  try {
    let store = new Store(path), scheduler = new Scheduler(store); const bot = store.createBot('Bot');
    const schedule = scheduler.create(bot.id, once(), start);
    assert.equal(scheduler.tick(start + minute - 1).length, 0);
    const fire = scheduler.tick(start + minute)[0]!;
    assert.equal(fire.outcome, 'queued'); assert.equal(fire.scheduledAt, start + minute);
    assert.equal(scheduler.get(bot.id, schedule.id).state, 'completed');
    assert.equal(scheduler.get(bot.id, schedule.id).nextRunAt, null);
    assert.deepEqual(store.events(bot.id, fire.taskId!).map(e => e.type), ['task.queued', 'schedule.fired']);
    assert.equal(store.changes().length, 2); assert.equal(store.tasks(bot.id).length, 1);
    assert.equal(store.submit(bot.id, fire.requestId, schedule.prompt).id, fire.taskId);
    store.close(); store = new Store(path); scheduler = new Scheduler(store);
    assert.equal(scheduler.tick(start + 100 * minute).length, 0);
    assert.equal(scheduler.history(bot.id, schedule.id).length, 1);
    assert.equal(store.tasks(bot.id).length, 1); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missed cron outage coalesces once, never one task per historical minute', () => {
  const { store, bot, scheduler } = fixture();
  const schedule = scheduler.create(bot.id, cron, start), now = start + 40 * 24 * 60 * minute + 17_000;
  const fires = scheduler.tick(now);
  assert.equal(fires.length, 1); assert.equal(fires[0]!.coalesced, true);
  assert.equal(fires[0]!.scheduledAt, start + minute); assert.equal(store.tasks(bot.id).length, 1);
  assert.equal(scheduler.get(bot.id, schedule.id).nextRunAt, Math.floor(now / minute) * minute + minute);
  assert.equal(scheduler.tick(now).length, 0); store.close();
});

test('each schedule skips queued, running and cancelling overlap, then admits after terminal', () => {
  const { store, bot, scheduler } = fixture(), schedule = scheduler.create(bot.id, cron, start);
  const first = scheduler.tick(start + minute)[0]!;
  for (const [i, state] of ['queued', 'running', 'cancelling'].entries()) {
    store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(state, first.taskId!);
    const fire = scheduler.tick(start + (i + 2) * minute)[0]!;
    assert.equal(fire.outcome, 'skipped_overlap'); assert.equal(fire.taskId, null);
    assert.equal(store.tasks(bot.id).length, 1);
  }
  store.db.prepare("UPDATE tasks SET state='interrupted' WHERE id=?").run(first.taskId!);
  assert.equal(scheduler.tick(start + 5 * minute)[0]!.outcome, 'queued');
  assert.equal(store.tasks(bot.id).length, 2); assert.equal(scheduler.history(bot.id, schedule.id).length, 5);
  store.close();
});

test('pause/resume skip paused cron intervals; once explicitly resumes overdue; delete does not cancel a task', () => {
  const { store, bot, scheduler } = fixture(), recurring = scheduler.create(bot.id, cron, start);
  scheduler.pause(bot.id, recurring.id, start); assert.equal(scheduler.get(bot.id, recurring.id).nextRunAt, null);
  assert.equal(scheduler.tick(start + 100 * minute).length, 0);
  assert.equal(scheduler.resume(bot.id, recurring.id, start + 100 * minute).nextRunAt, start + 101 * minute);
  assert.equal(scheduler.tick(start + 100 * minute).length, 0);
  const single = scheduler.create(bot.id, once(), start);
  scheduler.pause(bot.id, single.id, start); scheduler.resume(bot.id, single.id, start + 100 * minute);
  const fire = scheduler.tick(start + 100 * minute)[0]!; assert.equal(fire.scheduleId, single.id);
  scheduler.delete(bot.id, recurring.id, start + 100 * minute);
  scheduler.delete(bot.id, single.id, start + 100 * minute);
  assert.equal(store.task(bot.id, fire.taskId!).state, 'queued');
  assert.equal(scheduler.list(bot.id).length, 0); assert.equal(scheduler.tick(start + 1000 * minute).length, 0);
  assert.equal(scheduler.history(bot.id, single.id).length, 1);
  assert.throws(() => scheduler.resume(bot.id, recurring.id, start), /new schedule/); store.close();
});

test('bot addressing applies to get, mutation, history and status', () => {
  const { store, bot, scheduler } = fixture(), other = store.createBot('Other'), schedule = scheduler.create(bot.id, once(), start);
  for (const action of [() => scheduler.get(other.id, schedule.id), () => scheduler.update(other.id, schedule.id, once(), start), () => scheduler.pause(other.id, schedule.id, start), () => scheduler.resume(other.id, schedule.id, start), () => scheduler.delete(other.id, schedule.id, start), () => scheduler.history(other.id, schedule.id)]) assert.throws(action, /not found for this bot/);
  assert.equal(scheduler.list(other.id).length, 0); assert.equal(scheduler.status(other.id, start).counts.active, 0);
  assert.equal(scheduler.status(bot.id, start).nextRunAt, start + minute);
  assert.throws(() => scheduler.status('../other', start), /Invalid ID/); store.close();
});

test('schedule creation request replay remains idempotent after its run time and rejects mismatched content', () => {
  const { store, bot, scheduler } = fixture(), input = { ...once(), requestId: randomUUID() };
  const first = scheduler.create(bot.id, input, start); scheduler.tick(start + minute);
  assert.equal(scheduler.create(bot.id, input, start + 100 * minute).id, first.id);
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as ScheduleInput;
  assert.equal(scheduler.create(bot.id, reordered, start + 100 * minute).id, first.id);
  assert.throws(() => scheduler.create(bot.id, { ...input, prompt: 'Changed' }, start), /different content/);
  assert.equal(scheduler.list(bot.id).length, 1);
  assert.equal(scheduleRequestId(first.id, start), scheduleRequestId(first.id, start));
  assert.notEqual(scheduleRequestId(first.id, start), scheduleRequestId(first.id, start + minute)); store.close();
});

test('edit validates and reschedules active or paused input, without reviving deleted/completed schedules', () => {
  const { store, bot, scheduler } = fixture(), schedule = scheduler.create(bot.id, once(), start);
  const changed = scheduler.update(bot.id, schedule.id, { ...cron, cron: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' }, start);
  assert.equal(changed.kind, 'cron'); assert.equal(changed.nextRunAt, Date.parse('2026-10-13T01:00:00Z'));
  scheduler.pause(bot.id, schedule.id, start);
  assert.equal(scheduler.update(bot.id, schedule.id, once(), start).nextRunAt, null);
  scheduler.resume(bot.id, schedule.id, start); scheduler.tick(start + minute);
  assert.throws(() => scheduler.update(bot.id, schedule.id, cron, start), /new schedule/); store.close();
});

test('cron parses numeric ranges, lists, steps, Sunday 7 and day/weekday OR semantics', () => {
  assert.equal(next('*/15 9-17 * * 1-5', 'Asia/Shanghai', '2026-10-12T01:07:10Z'), '2026-10-12T01:15:00.000Z');
  assert.equal(next('5,35 12 * * *', 'UTC', '2026-10-12T12:05:00Z'), '2026-10-12T12:35:00.000Z');
  assert.equal(next('0 0 * * 7', 'UTC', '2026-10-12T12:00:00Z'), '2026-10-18T00:00:00.000Z');
  assert.equal(next('0 0 15 * 1', 'UTC', '2026-10-13T00:00:00Z'), '2026-10-15T00:00:00.000Z');
  assert.equal(next('0 0 15 * 1', 'UTC', '2026-10-16T00:00:00Z'), '2026-10-19T00:00:00.000Z');
  assert.equal(next('0 0 29 2 *', 'UTC', '2096-03-01T00:00:00Z'), '2104-02-29T00:00:00.000Z');
});

test('DST spring gap skips a nonexistent local minute instead of shifting it', () => {
  assert.equal(next('30 2 * * *', 'America/New_York', '2026-03-08T00:00:00Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T13:00:00Z'), '2026-10-04T15:15:00.000Z');
  assert.equal(next('0 12 * * *', 'Pacific/Apia', '2011-12-30T00:00:00Z'), '2011-12-30T22:00:00.000Z');
});

test('DST fall fold uses only the first occurrence, including minute-by-minute cron and half-hour fold', () => {
  assert.equal(next('30 1 * * *', 'America/New_York', '2026-11-01T00:00:00Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('* * * * *', 'America/New_York', '2026-11-01T05:59:00Z'), '2026-11-01T07:00:00.000Z');
  assert.equal(next('45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T14:45:00Z'), '2026-04-05T15:15:00.000Z');
});

test('DST fold remains once-only in durable scheduling over process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chestnut-fold-')), path = join(dir, 'db.sqlite');
  try {
    let store = new Store(path), scheduler = new Scheduler(store); const bot = store.createBot('Bot');
    scheduler.create(bot.id, { ...cron, cron: '30 1 * * *', timeZone: 'America/New_York' }, Date.parse('2026-11-01T00:00:00Z'));
    assert.equal(scheduler.tick(Date.parse('2026-11-01T05:30:00Z')).length, 1);
    store.close(); store = new Store(path); scheduler = new Scheduler(store);
    assert.equal(scheduler.tick(Date.parse('2026-11-01T06:30:00Z')).length, 0);
    assert.equal(store.tasks(bot.id).length, 1); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid schedules reject malformed cron/time zones, excessive prompts, impossible dates and past once', () => {
  const { store, bot, scheduler } = fixture();
  for (const expression of ['* * * * * *', '@hourly', '60 * * * *', '*/0 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '1-0 * * * *', '* * * * MON', ',1 * * * *', '0 0 31 2 *']) assert.throws(() => scheduler.create(bot.id, { ...cron, cron: expression }, start));
  for (const zone of ['Invalid/Zone', '+01:00', '', '../UTC']) assert.throws(() => scheduler.create(bot.id, { ...cron, timeZone: zone }, start), /time zone/);
  assert.throws(() => scheduler.create(bot.id, { ...cron, prompt: 'x'.repeat(32001) }, start), /32000/);
  assert.throws(() => scheduler.create(bot.id, once(start), start), /future/);
  assert.throws(() => scheduler.create(bot.id, once(NaN), start), /timestamp/);
  assert.throws(() => scheduler.tick(NaN), /timestamp/);
  assert.throws(() => store.submitInTransaction(bot.id, randomUUID(), 'Do not enqueue'), /active transaction/);
  assert.equal(store.tasks(bot.id).length, 0); assert.equal(scheduler.list(bot.id).length, 0); store.close();
});

test('per-bot caps and per-tick batch budget bound queue admissions', () => {
  const { store, bot, scheduler } = fixture();
  for (let i = 0; i < SCHEDULE_LIMITS.perBot; i++) scheduler.create(bot.id, once(), start);
  assert.throws(() => scheduler.create(bot.id, once(), start), /limit reached/);
  const other = store.createBot('Other'); scheduler.create(other.id, once(), start);
  assert.equal(scheduler.tick(start + minute).length, SCHEDULE_LIMITS.firesPerTick);
  assert.equal(scheduler.status(undefined, start + minute).due, 1);
  assert.equal(scheduler.tick(start + minute).length, 1); assert.equal(scheduler.tick(start + minute).length, 0); store.close();
});

test('a transaction failure rolls back task, request, fire, events and next run before a safe retry', () => {
  const { store, bot, scheduler } = fixture(), schedule = scheduler.create(bot.id, once(), start);
  store.db.exec("CREATE TRIGGER fail_schedule_fire BEFORE INSERT ON schedule_fires BEGIN SELECT RAISE(ABORT, 'Injected ledger failure'); END");
  assert.throws(() => scheduler.tick(start + minute), /Injected ledger failure/);
  assert.equal(store.tasks(bot.id).length, 0); assert.equal(store.changes().length, 0);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM requests')!.n, 0);
  assert.equal(scheduler.history(bot.id, schedule.id).length, 0);
  assert.equal(scheduler.get(bot.id, schedule.id).nextRunAt, start + minute);
  store.db.exec('DROP TRIGGER fail_schedule_fire'); assert.equal(scheduler.tick(start + minute).length, 1); store.close();
});

test('independent concurrent SQLite schedulers admit one task for the same fire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chestnut-schedule-race-')), path = join(dir, 'db.sqlite');
  try {
    const store = new Store(path), scheduler = new Scheduler(store), bot = store.createBot('Bot');
    const schedule = scheduler.create(bot.id, once(), start);
    const barrier = new SharedArrayBuffer(4), gate = new Int32Array(barrier);
    const code = `import { parentPort, workerData } from 'node:worker_threads';
      import { Store } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      import { Scheduler } from ${JSON.stringify(new URL('../src/schedules.ts', import.meta.url).href)};
      const store = new Store(workerData.path), scheduler = new Scheduler(store);
      parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      const fires = scheduler.tick(workerData.now); store.close(); parentPort.postMessage(fires.length);`;
    const workers = [0, 1].map(() => new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), { workerData: { path, barrier, now: start + minute } }));
    let ready = 0;
    const results = workers.map(worker => new Promise<number>((resolve, reject) => {
      worker.on('message', message => { if (message === 'ready') { if (++ready === 2) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } } else resolve(message as number); });
      worker.on('error', reject); worker.on('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
    }));
    assert.equal((await Promise.all(results)).reduce((a, b) => a + b, 0), 1);
    assert.equal(store.tasks(bot.id).length, 1); assert.equal(scheduler.history(bot.id, schedule.id).length, 1); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pause, edit and delete are durable across store reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chestnut-schedule-state-')), path = join(dir, 'db.sqlite');
  try {
    let store = new Store(path), scheduler = new Scheduler(store); const bot = store.createBot('Bot');
    const paused = scheduler.create(bot.id, cron, start), deleted = scheduler.create(bot.id, once(), start);
    scheduler.pause(bot.id, paused.id, start);
    scheduler.update(bot.id, paused.id, { ...cron, name: 'Edited', prompt: 'Edited prompt', cron: '0 12 * * *' }, start);
    scheduler.delete(bot.id, deleted.id, start);
    store.close(); store = new Store(path); scheduler = new Scheduler(store);
    assert.equal(scheduler.get(bot.id, paused.id).state, 'paused');
    assert.equal(scheduler.get(bot.id, paused.id).prompt, 'Edited prompt');
    assert.equal(scheduler.get(bot.id, deleted.id).state, 'deleted');
    assert.equal(scheduler.tick(start + 24 * 60 * minute).length, 0);
    const resumed = scheduler.resume(bot.id, paused.id, start + 24 * 60 * minute);
    assert.equal(resumed.nextRunAt, start + 48 * 60 * minute); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the fire uniqueness ledger prevents re-admission even when a due cursor is restored', () => {
  const { store, bot, scheduler } = fixture(), schedule = scheduler.create(bot.id, once(), start);
  scheduler.tick(start + minute);
  store.db.prepare("UPDATE schedules SET state='active',nextRunAt=? WHERE id=?").run(start + minute, schedule.id);
  assert.equal(scheduler.tick(start + minute).length, 0); assert.equal(store.tasks(bot.id).length, 1);
  assert.equal(scheduler.get(bot.id, schedule.id).state, 'completed'); store.close();
});
