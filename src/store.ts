import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, requireId, requireText, type Bot, type Task, type Run, type Command } from './types.ts';

type Bind = string | number | null;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_requests(requestId TEXT PRIMARY KEY,name TEXT NOT NULL,botId TEXT NOT NULL REFERENCES bots(id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),prompt TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),parentTaskId TEXT REFERENCES tasks(id),result TEXT,error TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(fence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,taskId TEXT NOT NULL REFERENCES tasks(id),botId TEXT NOT NULL,workerId TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,leaseUntil INTEGER NOT NULL,startedAt INTEGER NOT NULL,finishedAt INTEGER);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,messageId TEXT NOT NULL,taskId TEXT NOT NULL REFERENCES tasks(id),botId TEXT NOT NULL,type TEXT NOT NULL,text TEXT,state TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,UNIQUE(botId,messageId));
      CREATE TABLE IF NOT EXISTS requests(botId TEXT NOT NULL,messageId TEXT NOT NULL,payload TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(botId,messageId));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,botId TEXT NOT NULL,taskId TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,eventSeq INTEGER NOT NULL UNIQUE REFERENCES events(seq),createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,lastSeen INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_environments(botId TEXT PRIMARY KEY REFERENCES bots(id),profile TEXT NOT NULL,containerName TEXT NOT NULL,state TEXT NOT NULL,networkPolicy TEXT NOT NULL DEFAULT 'none',updatedAt INTEGER NOT NULL,containerId TEXT,imageId TEXT);
      CREATE TABLE IF NOT EXISTS environment_locks(botId TEXT PRIMARY KEY,runId TEXT NOT NULL,token TEXT NOT NULL,leaseUntil INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantines(runId TEXT PRIMARY KEY,botId TEXT NOT NULL,taskId TEXT NOT NULL,reason TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,botId TEXT NOT NULL,taskId TEXT NOT NULL,capability TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(state,createdAt);
      CREATE INDEX IF NOT EXISTS task_events ON events(taskId,seq);
      CREATE INDEX IF NOT EXISTS commands_pending ON commands(taskId,state,createdAt);`);
  }
  close() { this.db.close(); }
  get<T>(sql: string, ...args: Bind[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: Bind[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  bot(id: string): Bot { requireId(id); const value = this.get<Bot>('SELECT * FROM bots WHERE id=?', id); if (!value) throw new AppError(404, 'Bot not found'); return value; }
  task(botId: string, taskId: string): Task { this.bot(botId); requireId(taskId); const value = this.get<Task>('SELECT * FROM tasks WHERE botId=? AND id=?', botId, taskId); if (!value) throw new AppError(404, 'Task not found for this bot'); return value; }
  createBot(name: string, requestId?: string): Bot {
    requireText(name,80);const normalized=name.trim();
    const create=()=>{const bot={id:randomUUID(),name:normalized,createdAt:Date.now()};this.db.prepare('INSERT INTO bots VALUES (?,?,?)').run(bot.id,bot.name,bot.createdAt);return bot;};
    if(requestId===undefined)return create();requireId(requestId);
    return this.tx(()=>{const previous=this.get<{name:string;botId:string}>('SELECT * FROM bot_requests WHERE requestId=?',requestId);if(previous){if(previous.name!==normalized)throw new AppError(409,'Bot request ID was already used for a different name');return this.bot(previous.botId);}const bot=create();this.db.prepare('INSERT INTO bot_requests VALUES (?,?,?)').run(requestId,normalized,bot.id);return bot;});
  }
  botReceipt(requestId:string):Bot {requireId(requestId);const receipt=this.get<{botId:string}>('SELECT botId FROM bot_requests WHERE requestId=?',requestId);if(!receipt)throw new AppError(404,'Bot request not found');return this.bot(receipt.botId);}
  requestStatus(botId:string,messageId:string) {
    this.bot(botId);requireId(messageId);const receipt=this.get<{payload:string;response:string}>('SELECT payload,response FROM requests WHERE botId=? AND messageId=?',botId,messageId);if(!receipt)throw new AppError(404,'Request not found for this bot');
    const payload=JSON.parse(receipt.payload),original=JSON.parse(receipt.response);
    const response=payload.kind==='task'||payload.type==='follow_up'?this.task(botId,original.id):this.get<Command>('SELECT * FROM commands WHERE botId=? AND id=?',botId,original.id);
    if(!response)throw new AppError(404,'Request result not found');return {payload,response};
  }
  bots() { return this.all<Bot>('SELECT * FROM bots ORDER BY createdAt,id'); }
  tasks(botId: string) { this.bot(botId); return this.all<Task>('SELECT * FROM tasks WHERE botId=? ORDER BY createdAt DESC,rowid DESC LIMIT 200', botId); }
  private idempotent<T>(botId: string, messageId: string, payload: unknown, action: () => T): T {
    this.bot(botId); requireId(messageId); const serialized = JSON.stringify(payload);
    const previous = this.get<{payload: string; response: string}>('SELECT payload,response FROM requests WHERE botId=? AND messageId=?', botId, messageId);
    if (previous) { if (previous.payload !== serialized) throw new AppError(409, 'Message ID was already used for different content'); return JSON.parse(previous.response) as T; }
    const value = action(); this.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(botId, messageId, serialized, JSON.stringify(value)); return value;
  }
  private insertTask(botId: string, prompt: string, parentTaskId: string | null = null): Task {
    const now = Date.now(), task: Task = {id: randomUUID(),botId,prompt,state:'queued',parentTaskId,result:null,error:null,createdAt:now,updatedAt:now};
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)').run(task.id,botId,prompt,'queued',parentTaskId,null,null,now,now);
    this.event(botId,task.id,'task.queued',{parentTaskId}); return task;
  }
  submit(botId: string, messageId: string, prompt: string): Task {
    requireText(prompt); return this.tx(() => this.submitInTransaction(botId,messageId,prompt));
  }
  /** Trusted control-plane callers can atomically enqueue with their own durable ledger. */
  submitInTransaction(botId: string, messageId: string, prompt: string): Task {
    if (!this.db.isTransaction) throw new Error('submitInTransaction requires an active transaction');
    requireText(prompt); return this.idempotent(botId,messageId,{kind:'task',prompt},() => this.insertTask(botId,prompt));
  }
  command(botId: string, taskId: string, messageId: string, type: string, text?: string): Task | Command {
    if (!['steer','follow_up','cancel'].includes(type)) throw new AppError(400,'Invalid command type');
    if (type !== 'cancel') requireText(text);
    return this.tx(() => this.idempotent(botId,messageId,{kind:'command',taskId,type,text:text ?? null},() => {
      const task = this.task(botId,taskId), now=Date.now();
      if (type === 'follow_up') { if (['cancelled','interrupted','cancelling'].includes(task.state)) throw new AppError(409,'Cannot follow up a cancelled or interrupted task; submit a new task after reviewing its outcome'); return this.insertTask(botId,text!,taskId); }
      if (type === 'steer' && task.state !== 'running') throw new AppError(409,'Steering requires a running task; use follow-up to queue new work');
      const command: Command = {id:randomUUID(),messageId,taskId,botId,type:type as 'steer'|'cancel',text:text ?? null,state:'pending'};
      if (type === 'cancel') {
        if (task.state === 'queued') this.db.prepare("UPDATE tasks SET state='cancelled',updatedAt=? WHERE id=?").run(now,taskId);
        else if (['running','cancelling'].includes(task.state)) this.db.prepare("UPDATE tasks SET state='cancelling',updatedAt=? WHERE id=?").run(now,taskId);
        else throw new AppError(409,'Task is already terminal');
        this.db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM tasks WHERE parentTaskId=? UNION ALL SELECT t.id FROM tasks t JOIN children c ON t.parentTaskId=c.id) UPDATE tasks SET state='cancelled',updatedAt=? WHERE id IN (SELECT id FROM children) AND state='queued'`).run(taskId,now);
        this.db.prepare("UPDATE commands SET state='cancelled',updatedAt=? WHERE taskId=? AND state='pending'").run(now,taskId);
        if (task.state === 'queued') command.state='sent_unconfirmed';
      }
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?,?,?,?)').run(command.id,messageId,taskId,botId,type,command.text,command.state,now,now);
      this.event(botId,taskId,`command.${type}.accepted`,{commandId:command.id,messageId}); return command;
    }));
  }
  event(botId: string, taskId: string, type: string, data: unknown) {
    const now=Date.now(); const result=this.db.prepare('INSERT INTO events(botId,taskId,type,data,createdAt) VALUES (?,?,?,?,?)').run(botId,taskId,type,JSON.stringify(data ?? null),now);
    this.db.prepare('INSERT INTO outbox(eventSeq,createdAt) VALUES (?,?)').run(result.lastInsertRowid,now);
  }
  events(botId: string, taskId: string, after=0) { this.task(botId,taskId); return this.all<{seq:number;type:string;data:string;createdAt:number}>('SELECT seq,type,data,createdAt FROM events WHERE botId=? AND taskId=? AND seq>? ORDER BY seq LIMIT 500',botId,taskId,after).map(e=>({...e,data:JSON.parse(e.data)})); }
  changes(after=0) { return this.all<{seq:number;botId:string;taskId:string;type:string;data:string;createdAt:number}>('SELECT o.seq,e.botId,e.taskId,e.type,e.data,e.createdAt FROM outbox o JOIN events e ON e.seq=o.eventSeq WHERE o.seq>? ORDER BY o.seq LIMIT 500',after).map(e=>({...e,data:JSON.parse(e.data)})); }
  heartbeat(workerId: string, now=Date.now(), ttl=15000) { this.db.prepare('INSERT INTO workers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET lastSeen=excluded.lastSeen,expiresAt=excluded.expiresAt').run(workerId,now,now+ttl); }
  workerStatus(now=Date.now()) { const latest=this.get<{lastSeen:number;expiresAt:number}>('SELECT lastSeen,expiresAt FROM workers ORDER BY lastSeen DESC LIMIT 1'); return {online:!!this.get('SELECT id FROM workers WHERE expiresAt>? LIMIT 1',now),lastSeen:latest?.lastSeen ?? null}; }
  recover(now=Date.now()) { return this.tx(() => this.recoverInner(now)); }
  private recoverInner(now: number) {
    const expired=this.all<Run>("SELECT * FROM runs WHERE state='running' AND leaseUntil<=?",now);
    for (const run of expired) {
      this.db.prepare("UPDATE runs SET state='interrupted',finishedAt=? WHERE id=?").run(now,run.id);
      this.db.prepare("UPDATE tasks SET state='interrupted',error=?,updatedAt=? WHERE id=? AND state IN ('running','cancelling')").run('Worker lease expired. Outcome may be unknown; external effects were not replayed.',now,run.taskId);
      this.db.prepare("UPDATE commands SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'cancelled' END,updatedAt=? WHERE taskId=? AND state IN ('sending','pending')").run(now,run.taskId);
      // Follow-ups rely on a known predecessor outcome. A human must submit a new task after reviewing an interruption.
      this.db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM tasks WHERE parentTaskId=? UNION ALL SELECT t.id FROM tasks t JOIN children c ON t.parentTaskId=c.id) UPDATE tasks SET state='cancelled',error='Predecessor interrupted; explicit resubmission required',updatedAt=? WHERE id IN (SELECT id FROM children) AND state='queued'`).run(run.taskId,now);
      this.db.prepare('INSERT OR IGNORE INTO quarantines VALUES (?,?,?,?,?)').run(run.id,run.botId,run.taskId,'Expired lease; sandbox cleanup unverified',now);
      this.setEnvironmentState(run.botId,'quarantined');
      this.event(run.botId,run.taskId,'task.interrupted',{reason:'lease_expired',runId:run.id});
    }
    return expired.length;
  }
  ensureEnvironment(botId:string,profile:'ephemeral'|'persistent'|'service') {
    this.bot(botId);const existing=this.get<{profile:string}>('SELECT * FROM bot_environments WHERE botId=?',botId);
    if(existing&&existing.profile!==profile)throw new AppError(409,'Bot environment profile cannot change implicitly');
    this.db.prepare("INSERT OR IGNORE INTO bot_environments VALUES (?,?,?,'unprovisioned','none',?,NULL,NULL)").run(botId,profile,profile==='persistent'?`chestnut-bot-${botId}`:profile==='service'?`chestnut-env-${botId}`:'per-run',Date.now());
  }
  environment(botId:string) { this.bot(botId);return this.get<{botId:string;profile:string;containerName:string;state:string;networkPolicy:string;containerId:string|null;imageId:string|null}>('SELECT * FROM bot_environments WHERE botId=?',botId) ?? null; }
  observeEnvironment(botId:string,observed:{containerId:string;imageId:string;state:'running'|'stopped'}) {
    const existing=this.environment(botId);if(!existing)throw new Error('Bot environment is not registered');
    if(existing.containerId && existing.containerId!==observed.containerId)throw new Error('Persistent bot container identity changed; explicit recovery required');
    if(existing.imageId && existing.imageId!==observed.imageId)throw new Error('Persistent bot image identity changed; explicit recovery required');
    this.db.prepare('UPDATE bot_environments SET containerId=?,imageId=?,state=?,updatedAt=? WHERE botId=?').run(observed.containerId,observed.imageId,observed.state,Date.now(),botId);
  }
  noteQuarantine(runId:string,reason:string) {this.db.prepare('UPDATE quarantines SET reason=? WHERE runId=?').run(reason.slice(0,1000),runId);}
  setEnvironmentState(botId:string,state:'starting'|'running'|'stopped'|'quarantined') {this.db.prepare('UPDATE bot_environments SET state=?,updatedAt=? WHERE botId=?').run(state,Date.now(),botId);}
  quarantines() { return this.all<{runId:string;botId:string;taskId:string;reason:string}>('SELECT * FROM quarantines'); }
  clearQuarantine(runId:string) { this.tx(()=>{ const q=this.get<{botId:string}>('SELECT botId FROM quarantines WHERE runId=?',runId);if(q)this.setEnvironmentState(q.botId,'stopped'); this.db.prepare('DELETE FROM environment_locks WHERE runId=?').run(runId); this.db.prepare('DELETE FROM quarantines WHERE runId=?').run(runId); }); }
  claim(workerId: string, now=Date.now(), ttl=15000): Run | null {
    return this.tx(() => {
      this.recoverInner(now);
      if (this.get("SELECT id FROM runs WHERE state='running' LIMIT 1") || this.get('SELECT runId FROM quarantines LIMIT 1')) return null;
      const task=this.get<Task>(`SELECT t.* FROM tasks t WHERE t.state='queued' AND (t.parentTaskId IS NULL OR EXISTS (SELECT 1 FROM tasks p WHERE p.id=t.parentTaskId AND p.state IN ('succeeded','failed'))) ORDER BY t.createdAt,t.rowid LIMIT 1`);
      if (!task) return null;
      const id=randomUUID(),token=randomUUID();
      this.db.prepare("INSERT INTO runs(id,taskId,botId,workerId,token,state,leaseUntil,startedAt) VALUES (?,?,?,?,?,'running',?,?)").run(id,task.id,task.botId,workerId,token,now+ttl,now);
      const run=this.get<Run>('SELECT * FROM runs WHERE id=?',id)!;
      this.db.prepare('INSERT INTO environment_locks VALUES (?,?,?,?)').run(task.botId,id,token,now+ttl);
      this.db.prepare("UPDATE tasks SET state='running',updatedAt=? WHERE id=?").run(now,task.id);
      this.event(task.botId,task.id,'task.running',{runId:id,fence:run.fence}); return run;
    });
  }
  private valid(run: Run, now=Date.now()) { return !!this.get("SELECT id FROM runs WHERE id=? AND token=? AND state='running' AND leaseUntil>?",run.id,run.token,now); }
  isCurrent(run:Run) { return this.valid(run); }
  mayExecute(run:Run) { return this.valid(run) && this.task(run.botId,run.taskId).state==='running'; }
  renew(run: Run, now=Date.now(), ttl=15000) { return this.tx(() => { if (!this.valid(run,now)) return false; this.db.prepare('UPDATE runs SET leaseUntil=? WHERE id=?').run(now+ttl,run.id); this.db.prepare('UPDATE environment_locks SET leaseUntil=? WHERE runId=? AND token=?').run(now+ttl,run.id,run.token); return true; }); }
  appendRunEvent(run: Run, type: string, data: unknown, now=Date.now()) { return this.tx(()=>{ if (!this.valid(run,now)) return false; this.event(run.botId,run.taskId,type,data); return true; }); }
  takeCommand(run: Run, allowSteer=true): Command | null { return this.tx(()=>{ if (!this.valid(run)) return null; const cmd=this.get<Command>("SELECT * FROM commands WHERE taskId=? AND state='pending' AND (type='cancel' OR ?=1) ORDER BY CASE WHEN type='cancel' THEN 0 ELSE 1 END,createdAt,rowid LIMIT 1",run.taskId,allowSteer?1:0); if(!cmd)return null; this.db.prepare("UPDATE commands SET state='sending',updatedAt=? WHERE id=?").run(Date.now(),cmd.id); return {...cmd,state:'sending'}; }); }
  finishCommand(run: Run, id: string, success: boolean) { return this.tx(()=>{ if(!this.valid(run))return false; this.db.prepare("UPDATE commands SET state=?,updatedAt=? WHERE id=? AND taskId=? AND state='sending'").run(success?'sent_unconfirmed':'uncertain',Date.now(),id,run.taskId); this.event(run.botId,run.taskId,success?'command.sent_unconfirmed':'command.uncertain',{commandId:id}); return true; }); }
  finish(run: Run, state: 'succeeded'|'failed'|'cancelled'|'interrupted', result: string|null, error: string|null, now=Date.now(), cleanupConfirmed=true) {
    return this.tx(()=>{
      if(!this.valid(run,now))return false;
      if(!cleanupConfirmed)state='interrupted';
      const task=this.task(run.botId,run.taskId); if(task.state==='cancelling' && cleanupConfirmed) state='cancelled';
      this.db.prepare('UPDATE tasks SET state=?,result=?,error=?,updatedAt=? WHERE id=?').run(state,result,error,now,run.taskId);
      this.db.prepare('UPDATE runs SET state=?,finishedAt=? WHERE id=?').run(state,now,run.id);
      if(cleanupConfirmed)this.db.prepare('DELETE FROM environment_locks WHERE runId=? AND token=?').run(run.id,run.token);
      else this.db.prepare('INSERT OR IGNORE INTO quarantines VALUES (?,?,?,?,?)').run(run.id,run.botId,run.taskId,error ?? 'Sandbox cleanup unverified',now);
      this.db.prepare("UPDATE commands SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'cancelled' END,updatedAt=? WHERE taskId=? AND state IN ('pending','sending')").run(now,run.taskId);
      if(state==='interrupted' || state==='cancelled') this.db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM tasks WHERE parentTaskId=? UNION ALL SELECT t.id FROM tasks t JOIN children c ON t.parentTaskId=c.id) UPDATE tasks SET state='cancelled',error='Predecessor interrupted or cancelled; explicit resubmission required',updatedAt=? WHERE id IN (SELECT id FROM children) AND state='queued'`).run(run.taskId,now);
      this.event(run.botId,run.taskId,`task.${state}`,{result,error,runId:run.id}); return true;
    });
  }
}
