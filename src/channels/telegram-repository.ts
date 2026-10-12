import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import type { TelegramConfig } from './telegram-config.ts';

type Binding = Pick<TelegramConfig, 'telegramBotId' | 'botId' | 'ownerId' | 'chatId'>;
export interface Delivery { id: number; taskId: string | null; text: string; attempts: number }
export interface Reply { key: string; text: string; taskId?: string }
const LEASE_MS = 60_000;

/** State in the coordinator's protected SQLite WAL. No token, inbound payload, or provider error is stored. */
export class TelegramRepository {
  private store: Store;
  private owner = randomUUID();
  private now: () => number;
  constructor(store: Store, binding: Binding, now: () => number = Date.now) {
    this.store = store; this.now = now; store.bot(binding.botId);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_channel (
        id INTEGER PRIMARY KEY CHECK(id=1),telegramBotId TEXT NOT NULL,botId TEXT NOT NULL REFERENCES bots(id),ownerId TEXT NOT NULL,chatId TEXT NOT NULL,
        nextOffset INTEGER NOT NULL DEFAULT 0,leaseOwner TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'idle',
        lastSeen INTEGER,lastError TEXT,lastSendAt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram_updates (updateId INTEGER PRIMARY KEY,requestId TEXT NOT NULL,outcome TEXT NOT NULL,taskId TEXT);
      CREATE TABLE IF NOT EXISTS telegram_tasks (taskId TEXT PRIMARY KEY REFERENCES tasks(id),lastState TEXT NOT NULL,terminalQueued INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,dedupeKey TEXT NOT NULL UNIQUE,taskId TEXT,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,nextAttemptAt INTEGER NOT NULL DEFAULT 0,remoteMessageId INTEGER,errorKind TEXT);
      CREATE INDEX IF NOT EXISTS telegram_pending_deliveries ON telegram_deliveries(state,nextAttemptAt,id);
    `);
    store.tx(() => {
      const prior = store.get<Binding>('SELECT telegramBotId,botId,ownerId,chatId FROM telegram_channel WHERE id=1');
      if (prior && Object.keys(binding).some(key => prior[key as keyof Binding] !== binding[key as keyof Binding])) throw new Error('Telegram channel binding changed; use a separate data directory or explicitly review and migrate channel state');
      store.db.prepare('INSERT OR IGNORE INTO telegram_channel(id,telegramBotId,botId,ownerId,chatId) VALUES (1,?,?,?,?)').run(binding.telegramBotId,binding.botId,binding.ownerId,binding.chatId);
    });
  }
  acquire() {
    this.store.tx(() => {
      const row = this.store.get<{ leaseOwner: string | null; leaseUntil: number }>('SELECT leaseOwner,leaseUntil FROM telegram_channel WHERE id=1')!;
      if (row.leaseOwner && row.leaseUntil > this.now()) throw new Error('Telegram channel is already running');
      this.store.db.prepare("UPDATE telegram_channel SET leaseOwner=?,leaseUntil=?,status='running',lastError=NULL WHERE id=1").run(this.owner,this.now()+LEASE_MS);
      // sendMessage has no idempotency key. A previous process may have delivered these messages.
      this.store.db.prepare("UPDATE telegram_deliveries SET state='uncertain',errorKind='process_interrupted' WHERE state='sending'").run();
    });
  }
  assertOwned() {
    if (!this.store.get('SELECT id FROM telegram_channel WHERE id=1 AND leaseOwner=? AND leaseUntil>?',this.owner,this.now())) throw new Error('Telegram channel lease lost');
  }
  renew() {
    const result = this.store.db.prepare('UPDATE telegram_channel SET leaseUntil=? WHERE id=1 AND leaseOwner=? AND leaseUntil>?').run(this.now()+LEASE_MS,this.owner,this.now());
    if (!result.changes) throw new Error('Telegram channel lease lost');
  }
  release(status = 'stopped', error: string | null = null) {
    this.store.db.prepare('UPDATE telegram_channel SET leaseOwner=NULL,leaseUntil=0,status=?,lastError=? WHERE id=1 AND leaseOwner=?').run(status,error,this.owner);
  }
  health(status: 'running' | 'backoff', error: string | null = null) {
    this.assertOwned();
    this.store.db.prepare('UPDATE telegram_channel SET status=?,lastError=?,lastSeen=? WHERE id=1 AND leaseOwner=?').run(status,error,this.now(),this.owner);
  }
  offset() { return this.store.get<{ nextOffset: number }>('SELECT nextOffset FROM telegram_channel WHERE id=1')!.nextOffset; }
  hasUpdate(id: number) { return id < this.offset() || !!this.store.get('SELECT updateId FROM telegram_updates WHERE updateId=?',id); }
  private enqueue(reply: Reply) {
    this.store.db.prepare('INSERT OR IGNORE INTO telegram_deliveries(dedupeKey,taskId,text) VALUES (?,?,?)').run(reply.key,reply.taskId ?? null,reply.text);
  }
  completeUpdate(updateId: number, requestId: string, outcome: string, reply?: Reply, watch?: { id: string; state: string }) {
    this.store.tx(() => {
      this.assertOwned();
      if (reply) this.enqueue(reply);
      if (watch) this.store.db.prepare('INSERT OR IGNORE INTO telegram_tasks(taskId,lastState) VALUES (?,?)').run(watch.id,watch.state);
      this.store.db.prepare('INSERT OR IGNORE INTO telegram_updates VALUES (?,?,?,?)').run(updateId,requestId,outcome,watch?.id ?? reply?.taskId ?? null);
      this.store.db.prepare('UPDATE telegram_channel SET nextOffset=MAX(nextOffset,?) WHERE id=1').run(updateId+1);
    });
  }
  watched() { return this.store.all<{ taskId: string; lastState: string }>('SELECT taskId,lastState FROM telegram_tasks WHERE terminalQueued=0 ORDER BY rowid LIMIT 100'); }
  projectTask(taskId: string, state: string, terminal: boolean, reply: Reply) {
    this.store.tx(() => {
      this.assertOwned(); this.enqueue(reply);
      this.store.db.prepare('UPDATE telegram_tasks SET lastState=?,terminalQueued=? WHERE taskId=?').run(state,terminal?1:0,taskId);
    });
  }
  takeDelivery(): Delivery | null {
    return this.store.tx(() => {
      this.assertOwned();
      const last = this.store.get<{ lastSendAt: number }>('SELECT lastSendAt FROM telegram_channel WHERE id=1')!.lastSendAt;
      // One private chat, at most one outbound attempt per second. Preserve reply order across rate limits.
      if (last && this.now() < last+1000) return null;
      const row = this.store.get<Delivery & { nextAttemptAt: number }>("SELECT id,taskId,text,attempts,nextAttemptAt FROM telegram_deliveries WHERE state='pending' ORDER BY id LIMIT 1");
      if (!row || row.nextAttemptAt > this.now()) return null;
      this.store.db.prepare("UPDATE telegram_deliveries SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(row.id);
      this.store.db.prepare('UPDATE telegram_channel SET lastSendAt=? WHERE id=1').run(this.now());
      return { ...row, attempts: row.attempts+1 };
    });
  }
  finishDelivery(id: number, state: 'sent' | 'failed' | 'uncertain' | 'pending', error: string | null = null, remoteMessageId: number | null = null, delay = 0) {
    this.assertOwned();
    this.store.db.prepare("UPDATE telegram_deliveries SET state=?,errorKind=?,remoteMessageId=?,nextAttemptAt=? WHERE id=? AND state='sending'").run(state,error,remoteMessageId,this.now()+delay,id);
  }
}
