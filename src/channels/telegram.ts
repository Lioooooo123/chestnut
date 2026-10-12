import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, isId, type Task } from '../types.ts';
import type { Store } from '../store.ts';
import { telegramConfig, type TelegramConfig } from './telegram-config.ts';
import { TelegramRepository, type Reply } from './telegram-repository.ts';
import { TelegramError, TelegramTransport, type TelegramFetch } from './telegram-transport.ts';
export { telegramConfig, telegramReadiness, type TelegramConfig } from './telegram-config.ts';

const HELP = 'Send a text message to queue a task.\n/status [task UUID]\n/cancel <task UUID>\n/steer <task UUID> <instruction>\n/followup <task UUID> <instruction>\n/help\nOnly plain text in your configured private chat is supported.';
const TERMINAL = new Set(['succeeded','failed','cancelled','interrupted']);
const unsupported = ['forward_origin','forward_from','forward_from_chat','sender_chat','via_bot','is_automatic_forward','message_thread_id','business_connection_id','guest_query_id','photo','document','audio','video','voice','video_note','sticker','animation','contact','location','venue','poll','dice','game','story','paid_media','passport_data','web_app_data','rich_message'];
const tokenPattern = /\b\d{4,16}:[A-Za-z0-9_-]{20,128}\b/g;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const numericId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function telegramRequestId(telegramBotId: string, updateId: number) {
  const b = createHash('sha256').update(`chestnut:telegram:${telegramBotId}:update:${updateId}`).digest().subarray(0,16);
  b[6] = (b[6]! & 0x0f) | 0x50; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export interface TelegramDependencies {
  fetch?: TelegramFetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Dedicated outer process. Task execution and shell/network access remain owned by Worker. */
export class TelegramChannelRunner {
  #token: string;
  private binding: Omit<TelegramConfig, 'token'>;
  private store: Store;
  private repo: TelegramRepository;
  private transport: TelegramTransport;
  private controller = new AbortController();
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private acquired = false;
  private running = false;
  private pollFailures = 0;
  private fatal: string | null = null;
  constructor(store: Store, input: TelegramConfig, deps: TelegramDependencies = {}) {
    const c = telegramConfig({ CHESTNUT_TELEGRAM_ENABLED:'1', CHESTNUT_TELEGRAM_BOT_TOKEN:input.token,
      CHESTNUT_TELEGRAM_OWNER_ID:input.ownerId,CHESTNUT_TELEGRAM_CHAT_ID:input.chatId,CHESTNUT_TELEGRAM_BOT_ID:input.botId })!;
    this.#token = c.token;
    this.binding = { telegramBotId:c.telegramBotId,ownerId:c.ownerId,chatId:c.chatId,botId:c.botId };
    this.store = store; this.repo = new TelegramRepository(store,this.binding,deps.now);
    this.transport = new TelegramTransport(c.token,deps.fetch);
    this.sleep = deps.sleep ?? ((ms,signal) => delay(ms,undefined,{signal}));
  }
  /** Acquire without network I/O; useful for embedding and deterministic synthetic tests. */
  start() { if (this.acquired || this.controller.signal.aborted) throw new Error('Telegram runner cannot be restarted'); this.repo.acquire(); this.acquired=true; }
  stop() { this.controller.abort(); }
  private guard() { if (!this.acquired || this.controller.signal.aborted) throw new TelegramError('stopped'); this.repo.assertOwned(); }
  private safe(text: string) {
    const clean = text.split(this.#token).join('[redacted]').replace(tokenPattern,'[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
    if (clean.length <= 3900) return clean;
    return [...clean.slice(0,3700)].filter(c=>!/[\uD800-\uDFFF]/u.test(c)).join('') + '\n[Truncated. Open the local dashboard for the full result.]';
  }
  private status(task: Task) {
    return this.safe(`Task ${task.id}: ${task.state}${task.state==='succeeded' ? `\n${task.result || '(No text result)'}` : task.state==='failed' ? '\nTask failed. Review details in the local dashboard.' : task.state==='interrupted' ? '\nOutcome may be unknown. Review it before submitting new work.' : ''}`);
  }
  private accepted(updateId: number, text: string, task?: Task): Reply { return {key:`update:${updateId}`,text:this.safe(text),...(task?{taskId:task.id}:{})}; }
  private processUpdate(update: Record<string, any>) {
    this.guard();
    const id = update.update_id as number; if (this.repo.hasUpdate(id)) return;
    const requestId = telegramRequestId(this.binding.telegramBotId,id), message = update.message;
    // Never reply to or persist content from an unauthorized sender, chat, group, or alternate update type.
    if (!object(message) || !object(message.from) || !object(message.chat) || message.chat.type !== 'private'
      || message.from.is_bot !== false || !numericId(message.from.id) || !numericId(message.chat.id)
      || String(message.from.id) !== this.binding.ownerId || String(message.chat.id) !== this.binding.chatId) {
      this.repo.completeUpdate(id,requestId,'ignored'); return;
    }
    if (!numericId(message.message_id) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4096
      || unsupported.some(key => key in message)) {
      this.repo.completeUpdate(id,requestId,'unsupported',this.accepted(id,'Only plain text messages are supported. Send /help for commands.')); return;
    }
    const text = message.text.trim();
    if (text.includes(this.#token) || new RegExp(tokenPattern.source).test(text)) {
      this.repo.completeUpdate(id,requestId,'rejected',this.accepted(id,'This message appears to contain a bot credential. It was not queued. Remove the credential and resend.')); return;
    }
    let reply: Reply, watch: Task | undefined;
    try {
      if (!text.startsWith('/')) {
        const task = this.store.submit(this.binding.botId,requestId,text); watch=task;
        reply=this.accepted(id,`Queued task ${task.id}.\n/status ${task.id}\n/cancel ${task.id}`,task);
      } else {
        const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
        const command = match?.[1]?.toLowerCase(), args = match?.[2]?.trim() ?? '';
        if ((command==='help'||command==='start') && !args) reply=this.accepted(id,HELP);
        else if (command==='status') {
          if (args) { if(!isId(args)) throw new AppError(400,'Invalid task ID'); reply=this.accepted(id,this.status(this.store.task(this.binding.botId,args))); }
          else {
            const tasks=this.store.tasks(this.binding.botId).slice(0,5);
            reply=this.accepted(id,`Worker ${this.store.workerStatus().online?'online':'offline'}. ${tasks.length?'Recent tasks:\n'+tasks.map(t=>`${t.id}: ${t.state}`).join('\n'):'No tasks yet.'}`);
          }
        } else if (command==='cancel'||command==='steer'||command==='followup') {
          const parts=/^(\S+)(?:\s+([\s\S]*))?$/.exec(args),taskId=parts?.[1],instruction=parts?.[2]?.trim();
          if(!isId(taskId)||(command==='cancel'?!!instruction:!instruction))throw new AppError(400,'Invalid command arguments');
          const result=this.store.command(this.binding.botId,taskId,requestId,command==='followup'?'follow_up':command,instruction);
          if (command==='followup') {
            watch=result as Task; reply=this.accepted(id,`Queued follow-up ${watch.id} after ${taskId}.`,watch);
          } else {
            watch=this.store.task(this.binding.botId,taskId);
            reply=this.accepted(id,command==='cancel'?`Cancellation requested for ${taskId}. Completion is confirmed separately.`:`Steering queued for ${taskId}. This receipt does not confirm that the running agent applied it.`,watch);
          }
        } else reply=this.accepted(id,`Unknown command or unsupported arguments.\n${HELP}`);
      }
    } catch(error) {
      // Unexpected storage faults must leave the offset unacknowledged; deterministic request IDs recover partial handoffs.
      if (!(error instanceof AppError)) throw error;
      const detail=error.status===404?'Task not found for this bot.':error.status===409?'The task state does not allow this command. Use /status to review it.':'Invalid command. Use /help for syntax.';
      reply=this.accepted(id,detail);
    }
    this.repo.completeUpdate(id,requestId,'handled',reply,watch);
  }
  async pollOnce() {
    this.guard();
    // Backpressure: leave incoming updates on Telegram until delivery catches up. Server retention is 24 hours.
    const pending=this.store.get<{count:number}>("SELECT COUNT(*) AS count FROM telegram_deliveries WHERE state IN ('pending','sending')")!.count;
    if (pending>=200) return;
    const updates=await this.transport.call('getUpdates',{offset:this.repo.offset(),limit:50,timeout:25,allowed_updates:['message']},this.controller.signal);
    this.guard();
    if (!Array.isArray(updates)||updates.length>100||updates.some(u=>!object(u)||!Number.isSafeInteger(u.update_id)||u.update_id<0||u.update_id===Number.MAX_SAFE_INTEGER)) throw new TelegramError('invalid_response');
    for(const update of updates.sort((a,b)=>a.update_id-b.update_id))this.processUpdate(update);
    this.repo.health('running');
  }
  async flushOnce() {
    this.guard();
    for(const watched of this.repo.watched()) {
      const task=this.store.task(this.binding.botId,watched.taskId),terminal=TERMINAL.has(task.state);
      if(terminal||task.state!==watched.lastState) {
        const text=terminal?this.status(task):`Task ${task.id}: ${task.state}.`;
        this.repo.projectTask(task.id,task.state,terminal,{key:`task:${task.id}:${task.state}`,taskId:task.id,text:this.safe(text)});
      }
    }
    const delivery=this.repo.takeDelivery(); if(!delivery)return;
    try {
      const result=await this.transport.call('sendMessage',{chat_id:this.binding.chatId,text:delivery.text,link_preview_options:{is_disabled:true}},this.controller.signal);
      if(!object(result)||!numericId(result.message_id)||!object(result.chat)||String(result.chat.id)!==this.binding.chatId)throw new TelegramError('invalid_response');
      this.repo.finishDelivery(delivery.id,'sent',null,result.message_id);
    } catch(error) {
      const kind=error instanceof TelegramError?error.kind:'network';
      if(kind==='rate_limited' && delivery.attempts<5)this.repo.finishDelivery(delivery.id,'pending',kind,null,(error as TelegramError).retryAfterMs);
      else this.repo.finishDelivery(delivery.id,['rate_limited','unauthorized','forbidden','rejected','conflict'].includes(kind)?'failed':'uncertain',kind);
      if(kind==='unauthorized'||kind==='forbidden'||kind==='conflict'){this.fatal=kind;this.stop();}
    }
  }
  async run() {
    if(this.running)throw new Error('Telegram runner is already running');
    this.start();this.running=true;
    const heartbeat=setInterval(()=>{try{this.repo.renew();}catch{this.fatal='lease_lost';this.stop();}},5000);
    const polling=async()=>{
      while(!this.controller.signal.aborted) {
        let wait=500;
        try{await this.pollOnce();this.pollFailures=0;}
        catch(error){
          if(this.controller.signal.aborted)break;
          const kind=error instanceof TelegramError?error.kind:'storage_unavailable';
          if(['unauthorized','forbidden','conflict'].includes(kind)){this.fatal=kind;this.stop();break;}
          wait=error instanceof TelegramError&&error.kind==='rate_limited'?error.retryAfterMs:Math.min(30_000,1000*2**Math.min(this.pollFailures++,5));
          this.repo.health('backoff',kind);
        }
        await this.sleep(wait,this.controller.signal);
      }
    };
    const sending=async()=>{while(!this.controller.signal.aborted){await this.flushOnce();await this.sleep(500,this.controller.signal);}};
    try {
      await Promise.all([polling(),sending()].map(async work=>{try{await work;}catch{if(!this.controller.signal.aborted){this.fatal='storage_unavailable';this.stop();}}}));
    } finally {clearInterval(heartbeat);this.repo.release(this.fatal?'blocked':'stopped',this.fatal);this.running=false;this.acquired=false;}
  }
  /** End an embedding/test session after outstanding calls settle. run() does this automatically. */
  close() { if(this.running)throw new Error('Stop and await run() before closing');this.stop();if(this.acquired)this.repo.release();this.acquired=false; }
}
