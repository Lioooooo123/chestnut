import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../store.ts';
import { type Config } from '../config.ts';
import { AppError, requireId, requireText, type Task } from '../types.ts';
import { MemoryRepository, type MemoryEntry, type MemoryKind, type MaintenanceCommit } from './repository.ts';
import { openAiMaintenanceProvider } from './provider.ts';
export interface MaintenanceTask { id: string; createdAt: number; user: string[]; result: string }
export interface MaintenanceInput { mode: 'extract' | 'dream'; tasks: MaintenanceTask[]; entries: MemoryEntry[]; signal: AbortSignal }
export interface MaintenancePlan {
  additions: { title: string; content: string; kind: MemoryKind; sourceTaskId: string; quote: string }[];
  removals: { id: string; revision: string; reason: string }[];
  conflicts: { title: string; content: string; sourceTaskId: string; quote: string }[];
}
export type MaintenanceProvider = (input: MaintenanceInput) => Promise<MaintenancePlan>;
interface Job { botId: string; state: string; token: string | null; leaseUntil: number; requested: string | null; lastRequest: string | null; retryAt: number; updatedAt: number; error: string | null; added: number; removed: number; provider: string }
const DAY = 86400000;
const secret = /(?:sk-[a-zA-Z0-9_-]{12,}|(?:password|api[_ -]?key|token|secret)\s*[:=]\s*\S+|-----BEGIN .*PRIVATE KEY|gh[pousr]_[a-zA-Z0-9]{12,})/i;
const safe = (text: string) => secret.test(text) ? '[credential-bearing text omitted]' : text;
const stableId = (value: string) => { const hex = createHash('sha256').update(value).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; };
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** Offline demo only learns explicit durable user requests. It never pretends to infer experience. */
export const explicitMaintenanceProvider: MaintenanceProvider = async input => {
  const additions: MaintenancePlan['additions'] = [];
  for (const task of input.tasks) for (const user of task.user) {
    const match = /^(?:记住|请记住|长期偏好|Remember)\s*[:：]\s*(.+)$/imu.exec(user);
    if (match && !secret.test(match[1]!)) additions.push({ title: Array.from(match[1]!).slice(0,60).join(''), content: match[1]!.trim(), kind: 'preference', sourceTaskId: task.id, quote: match[0]!.trim() });
  }
  const removals: MaintenancePlan['removals'] = []; const seen = new Map<string, MemoryEntry>();
  for (const entry of input.entries) {
    const key = `${entry.scope}:${entry.kind}:${normalized(entry.content)}`;
    if (seen.has(key) && entry.origin === 'automatic' && entry.scope === 'bot' && entry.kind === 'lesson') removals.push({ id: entry.id, revision: entry.revision, reason: 'duplicate' });
    else seen.set(key, entry);
  }
  return { additions: additions.slice(0,20), removals: removals.slice(0,20), conflicts: [] };
};
/** Cross-process leases/cost accounting live in the control ledger; notes and processed cursors commit together in Git. */
export class MemoryMaintenance {
  private readonly store: Store; private readonly c: Config; private readonly provider: MaintenanceProvider;
  private repo?: MemoryRepository;
  private running = false; private controller?: AbortController;
  constructor(store: Store, c: Config, provider?: MaintenanceProvider) {
    this.store = store; this.c = c;
    this.provider = provider ?? (c.mode === 'pi' && c.apiKey ? openAiMaintenanceProvider(c.apiKey, c.model) : explicitMaintenanceProvider);
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_jobs(botId TEXT PRIMARY KEY REFERENCES bots(id),state TEXT NOT NULL DEFAULT 'idle',token TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,requested TEXT,lastRequest TEXT,retryAt INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL DEFAULT 0,error TEXT,added INTEGER NOT NULL DEFAULT 0,removed INTEGER NOT NULL DEFAULT 0,provider TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS memory_budget(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,characters INTEGER NOT NULL);`);
  }
  status(botId: string) {
    this.store.bot(botId);
    return { automatic: this.c.memoryAutomatic ?? true, ...(this.store.get<Job>('SELECT * FROM memory_jobs WHERE botId=?',botId) ?? { botId, state: 'idle', token: null, leaseUntil: 0, requested: null, lastRequest: null, retryAt: 0, updatedAt: 0, error: null, added: 0, removed: 0, provider: this.c.mode === 'demo' ? 'explicit-demo' : 'openai' }), token: undefined };
  }
  requestDream(botId: string, requestId: string) {
    this.store.bot(botId); requireId(requestId);
    this.store.tx(() => {
      this.store.db.prepare('INSERT OR IGNORE INTO memory_jobs(botId) VALUES (?)').run(botId);
      const job = this.store.get<Job>('SELECT * FROM memory_jobs WHERE botId=?',botId)!;
      if (job.lastRequest === requestId || job.requested === requestId) return;
      if (job.requested) throw new AppError(409,'Dreaming is already queued');
      this.store.db.prepare('UPDATE memory_jobs SET requested=?,retryAt=0,updatedAt=? WHERE botId=?').run(requestId,Date.now(),botId);
    });
    return this.status(botId);
  }
  stop() { this.controller?.abort(); }
  private completed(botId: string, after: number, recent = false) {
    return this.store.all<Task & { terminalSeq: number }>(`SELECT t.*,MAX(e.seq) terminalSeq FROM tasks t JOIN events e ON e.taskId=t.id AND e.type IN ('task.succeeded','task.failed') WHERE t.botId=? AND t.state IN ('succeeded','failed') GROUP BY t.id HAVING terminalSeq${recent ? '<=' : '>'}? ORDER BY terminalSeq ${recent ? 'DESC' : 'ASC'} LIMIT 10`,botId,after);
  }
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true; this.controller = new AbortController();
    try {
      if (this.c.mode === 'pi' && !this.c.apiKey) return;
      const repo = this.repo ??= new MemoryRepository(join(this.c.root,'control','memory'));
      this.store.db.prepare("UPDATE memory_jobs SET state='interrupted',token=NULL,retryAt=0,error='Maintenance process stopped. Committed Git progress is retained.' WHERE token IS NOT NULL AND leaseUntil<=?").run(now);
      for (const bot of this.store.bots()) {
        const oldJob = this.store.get<Job>('SELECT * FROM memory_jobs WHERE botId=?',bot.id);
        if (oldJob?.requested && repo.hasMaintenanceReceipt(bot.id,oldJob.requested)) {
          this.store.db.prepare("UPDATE memory_jobs SET state='succeeded',requested=NULL,lastRequest=?,token=NULL,leaseUntil=0,retryAt=0,error=NULL,updatedAt=? WHERE botId=? AND requested=? AND token IS NULL").run(oldJob.requested,Date.now(),bot.id,oldJob.requested);
          continue;
        }
        if (!(this.c.memoryAutomatic ?? true) && !oldJob?.requested) continue;
        if (oldJob && oldJob.retryAt > now) continue;
        const progress = repo.maintenanceState(bot.id);
        const fresh = this.completed(bot.id,progress.cursor);
        const usedSinceDream = fresh.length > 0 || this.completed(bot.id,progress.cursor,true).some(t => t.updatedAt > progress.lastDreamAt);
        const dream = !!oldJob?.requested || (usedSinceDream && now - progress.lastDreamAt >= DAY);
        if (!fresh.length && !dream) continue;
        const snapshot = repo.snapshot(bot.id);
        if (!snapshot.enabled) continue;
        if (!snapshot.writable) { this.noteBlocked(bot.id,'Memory has uncommitted changes. Inspect the repository.'); continue; }
        const token = randomUUID();
        const admitted = this.store.tx(() => {
          if (this.store.get('SELECT botId FROM memory_jobs WHERE token IS NOT NULL AND leaseUntil>? LIMIT 1',now)) return false;
          this.store.db.prepare('INSERT OR IGNORE INTO memory_jobs(botId) VALUES (?)').run(bot.id);
          this.store.db.prepare("UPDATE memory_jobs SET token=?,leaseUntil=?,state='running',updatedAt=?,error=NULL,provider=? WHERE botId=?").run(token,now+90000,now,this.c.mode === 'demo' ? 'explicit-demo' : 'openai',bot.id); return true;
        });
        if (!admitted) return;
        const admittedRequest = oldJob?.requested ?? null;
        const heartbeat = setInterval(() => this.store.db.prepare('UPDATE memory_jobs SET leaseUntil=? WHERE botId=? AND token=?').run(Date.now()+90000,bot.id,token),2000);
        try {
          const candidateTasks = [...fresh,...(dream ? this.completed(bot.id,progress.cursor,true) : [])].filter(t => t.createdAt > progress.suppressedBefore);
          let remaining = 16000;
          const tasks: MaintenanceTask[] = [];
          for (const task of candidateTasks) {
            if (remaining < 1000) break;
            const steering = this.store.all<{text:string}>('SELECT text FROM commands WHERE taskId=? AND type=\'steer\' AND state=\'sent_unconfirmed\' ORDER BY createdAt LIMIT 10',task.id);
            const user = [task.prompt,...steering.map(c => c.text)].map(text => safe(text).slice(0,Math.min(3200,remaining))).filter(Boolean);
            const result = safe(task.result ?? '').slice(0,Math.min(4000,Math.max(0,remaining-user.join('').length)));
            const size = user.join('').length+result.length; if (size > remaining) break;
            tasks.push({ id: task.id, createdAt: task.createdAt, user, result }); remaining -= size;
          }
          const entries = snapshot.entries.slice(0,30).map(e => ({ ...e, content: safe(e.content).slice(0,200) }));
          const input: MaintenanceInput = { mode: dream ? 'dream' : 'extract', tasks, entries, signal: this.controller.signal };
          const chars = JSON.stringify({ tasks, entries }).length;
          const budget = this.store.tx(() => {
            const day = new Date(now).toISOString().slice(0,10);
            this.store.db.prepare('INSERT OR IGNORE INTO memory_budget VALUES (?,0,0)').run(day);
            const row = this.store.get<{calls:number;characters:number}>('SELECT calls,characters FROM memory_budget WHERE day=?',day)!;
            if (row.calls >= (this.c.memoryDailyCalls ?? 24) || row.characters+chars > 160000) return false;
            this.store.db.prepare('UPDATE memory_budget SET calls=calls+1,characters=characters+? WHERE day=?').run(chars,day); return true;
          });
          if (!budget) throw new AppError(429,'Daily memory maintenance budget reached');
          const plan = tasks.length || (dream && entries.length) ? await this.provider(input) : { additions: [], removals: [], conflicts: [] };
          this.validate(plan,input);
          // Only tasks actually provided (or intentionally suppressed) may advance the processed cursor.
          const covered = [];
          for (const task of fresh) { if (task.createdAt > progress.suppressedBefore && !tasks.some(s => s.id === task.id)) break; covered.push(task); }
          const cursor = covered.length ? covered.at(-1)!.terminalSeq : progress.cursor;
          const requestId = admittedRequest ?? stableId(`${bot.id}:${snapshot.version}:${cursor}:${dream ? Math.floor(now/DAY) : 'extract'}`);
          const committed = repo.applyMaintenance(bot.id,{ requestId, expectedVersion: snapshot.version, cursor, dreamAt: dream ? now : 0,
            additions: plan.additions.map(({quote,...note}) => note), removals: plan.removals, conflicts: plan.conflicts.map(({quote,...note}) => note) },() => {
              if (this.controller!.signal.aborted || !this.store.get('SELECT botId FROM memory_jobs WHERE botId=? AND token=? AND leaseUntil>?',bot.id,token,Date.now())) throw new AppError(409,'Maintenance lease revoked');
            });
          this.store.db.prepare("UPDATE memory_jobs SET state='succeeded',token=NULL,leaseUntil=0,retryAt=0,error=NULL,added=?,removed=?,updatedAt=?,lastRequest=COALESCE(?,lastRequest),requested=CASE WHEN requested=? THEN NULL ELSE requested END WHERE botId=? AND token=?").run(committed.added,committed.removed,Date.now(),admittedRequest,admittedRequest,bot.id,token);
          if (fresh[0]) this.store.event(bot.id,fresh[0].id,'memory.maintained',{version:committed.version,added:committed.added,removed:committed.removed,cursor,dream});
        } catch (error) {
          const message = error instanceof AppError ? error.message : 'Memory inference failed; no memory was committed. Retry after checking the provider.';
          this.store.db.prepare("UPDATE memory_jobs SET state='failed',token=NULL,leaseUntil=0,retryAt=?,error=?,updatedAt=? WHERE botId=? AND token=?").run(Date.now()+60000,message,Date.now(),bot.id,token);
        } finally { clearInterval(heartbeat); }
        return; // One bounded batch per scheduler tick; foreground tasks remain independent.
      }
    } finally { this.controller = undefined; this.running = false; }
  }
  private noteBlocked(botId: string,error: string) {
    this.store.db.prepare('INSERT OR IGNORE INTO memory_jobs(botId) VALUES (?)').run(botId);
    this.store.db.prepare("UPDATE memory_jobs SET state='blocked',error=?,retryAt=?,updatedAt=? WHERE botId=? AND (token IS NULL OR leaseUntil<=?)").run(error,Date.now()+60000,Date.now(),botId,Date.now());
  }
  private validate(plan: MaintenancePlan,input: MaintenanceInput) {
    if (!plan || !Array.isArray(plan.additions) || !Array.isArray(plan.removals) || !Array.isArray(plan.conflicts) || plan.additions.length > 20 || plan.removals.length > 20 || plan.conflicts.length > 20) throw new AppError(400,'Invalid memory inference plan');
    for (const note of [...plan.additions,...plan.conflicts]) {
      requireId(note.sourceTaskId); requireText(note.quote,4000); requireText(note.title,80); requireText(note.content,4000);
      const source = input.tasks.find(t => t.id === note.sourceTaskId);
      const texts = 'kind' in note && note.kind === 'lesson' ? [...(source?.user ?? []),source?.result ?? ''] : source?.user ?? [];
      if (!source || !texts.some(text => text.includes(note.quote)) || secret.test(note.content) || secret.test(note.title)) throw new AppError(400,'Memory proposal has invalid source evidence');
    }
  }
}
