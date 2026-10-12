import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { TelegramChannelRunner, telegramConfig, telegramReadiness, telegramRequestId } from '../src/channels/telegram.ts';
import { TelegramTransport, TelegramError, type TelegramFetch } from '../src/channels/telegram-transport.ts';

const TOKEN='123456:synthetic_test_token_123456789012345';
const environment=(botId:string):NodeJS.ProcessEnv=>({CHESTNUT_TELEGRAM_ENABLED:'1',CHESTNUT_TELEGRAM_BOT_TOKEN:TOKEN,CHESTNUT_TELEGRAM_OWNER_ID:'7001',CHESTNUT_TELEGRAM_CHAT_ID:'7001',CHESTNUT_TELEGRAM_BOT_ID:botId});
const incoming=(id:number,text:string)=>({update_id:id,message:{message_id:id+1,from:{id:7001,is_bot:false},chat:{id:7001,type:'private'},text}});
const response=(result:unknown)=>new Response(JSON.stringify({ok:true,result}),{status:200});
const failure=(code:number,extras:Record<string,unknown>={})=>new Response(JSON.stringify({ok:false,error_code:code,description:`Never persist ${TOKEN}`, ...extras}),{status:code});
function fixture(path=':memory:') {
  const store=new Store(path),bot=store.createBot('Telegram Test'),config=telegramConfig(environment(bot.id))!;
  let now=Date.now(),queue:unknown[]=[];const sent:Record<string,any>[]=[];const calls:{url:string;body:any;init:RequestInit}[]=[];
  let send:((body:any)=>Promise<Response>)|undefined;
  const fetcher:TelegramFetch=async(url,init)=>{
    const body=JSON.parse(String(init.body));calls.push({url,body,init});
    if(url.endsWith('/getUpdates'))return response(queue.splice(0,50));
    sent.push(body);return send?send(body):response({message_id:100+sent.length,chat:{id:7001,type:'private'}});
  };
  const runner=new TelegramChannelRunner(store,config,{fetch:fetcher,now:()=>now});runner.start();
  return {store,bot,config,runner,sent,calls,fetcher,queue,advance:()=>{now+=1001;},setSend:(fn:(body:any)=>Promise<Response>)=>{send=fn;},close:()=>{runner.close();store.close();}};
}

test('Telegram is opt-in, requires both numeric allowlist IDs and a Chestnut bot UUID; readiness never exposes token',()=>{
  const id=randomUUID();assert.equal(telegramConfig({CHESTNUT_TELEGRAM_BOT_TOKEN:TOKEN}),null);
  for(const change of [{CHESTNUT_TELEGRAM_ENABLED:'yes'},{CHESTNUT_TELEGRAM_BOT_TOKEN:''},{CHESTNUT_TELEGRAM_OWNER_ID:'@someone'},{CHESTNUT_TELEGRAM_CHAT_ID:'-500'},{CHESTNUT_TELEGRAM_BOT_ID:'../other'}])assert.throws(()=>telegramConfig({...environment(id),...change}));
  const f=fixture();try{const value=telegramReadiness(f.store,environment(f.bot.id));assert.equal(value.enabled,true);assert.equal(value.configured,true);assert.equal(JSON.stringify(value).includes(TOKEN),false);assert.equal(JSON.stringify(f.runner).includes(TOKEN),false);assert.equal(telegramReadiness(f.store,{}).enabled,false);}finally{f.close();}
});

test('only exact owner AND private chat create work; groups, bots, forged IDs and other update types get no reply',async()=>{
  const f=fixture();try{
    const wrongSender=incoming(1,'private secret');wrongSender.message.from.id=7002;
    const wrongChat=incoming(2,'private secret');wrongChat.message.chat.id=7002;
    const group=incoming(3,'private secret');group.message.chat.type='group';
    const bot=incoming(4,'private secret');bot.message.from.is_bot=true;
    f.queue.push(wrongSender,wrongChat,group,bot,{update_id:5,edited_message:incoming(5,'private secret').message},{update_id:6,message:{...incoming(6,'private secret').message,from:{id:'7001',is_bot:false}}});
    await f.runner.pollOnce();await f.runner.flushOnce();
    assert.equal(f.store.tasks(f.bot.id).length,0);assert.equal(f.sent.length,0);assert.equal(f.store.get<{nextOffset:number}>('SELECT nextOffset FROM telegram_channel')!.nextOffset,7);
    assert.equal(JSON.stringify(f.store.all('SELECT * FROM telegram_updates')).includes('private secret'),false);
  }finally{f.close();}
});

test('ordinary text queues via coordinator, gets durable receipt, and repeated update has no second task or reply',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(10,'Build a tiny test'));await f.runner.pollOnce();const task=f.store.tasks(f.bot.id)[0]!;
    assert.equal(task.prompt,'Build a tiny test');assert.equal(task.state,'queued');assert.equal(f.store.changes().length,1);
    await f.runner.flushOnce();assert.match(f.sent[0]!.text,new RegExp(`Queued task ${task.id}`));
    f.queue.push(incoming(10,'Build a tiny test'));await f.runner.pollOnce();f.advance();await f.runner.flushOnce();
    assert.equal(f.store.tasks(f.bot.id).length,1);assert.equal(f.sent.length,1);
    assert.equal(f.calls[0]!.url,`https://api.telegram.org/bot${TOKEN}/getUpdates`);assert.equal(f.calls[0]!.init.redirect,'error');
    assert.deepEqual(f.calls[0]!.body,{offset:0,limit:50,timeout:25,allowed_updates:['message']});
    assert.equal(f.calls.findLast(c=>c.url.endsWith('getUpdates'))!.body.offset,11);
    assert.equal(f.sent[0]!.chat_id,'7001');assert.equal('parse_mode' in f.sent[0]!,false);assert.deepEqual(f.sent[0]!.link_preview_options,{is_disabled:true});
  }finally{f.close();}
});

test('durable restart retains offset, command/task dedupe, pending receipts and watched results',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'chestnut-telegram-')),path=join(dir,'state.sqlite');const f=fixture(path);const botId=f.bot.id,config=f.config;
  try{
    f.queue.push(incoming(20,'restart test'));await f.runner.pollOnce();const task=f.store.tasks(botId)[0]!;f.runner.close();f.store.close();
    const store=new Store(path),sent:any[]=[];
    const runner=new TelegramChannelRunner(store,config,{fetch:async(url,init)=>{const b=JSON.parse(String(init.body));if(url.endsWith('getUpdates')){assert.equal(b.offset,21);return response([incoming(20,'restart test')]);}sent.push(b);return response({message_id:1,chat:{id:7001}});}});
    runner.start();try{await runner.pollOnce();await runner.flushOnce();assert.equal(store.tasks(botId).length,1);assert.equal(store.tasks(botId)[0]!.id,task.id);assert.equal(sent.length,1);assert.match(sent[0].text,/Queued task/);}finally{runner.close();store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('crash after Store.submit but before channel checkpoint reuses deterministic Store request ID',async()=>{
  const f=fixture();try{
    const id=telegramRequestId(f.config.telegramBotId,30),first=f.store.submit(f.bot.id,id,'already committed');
    f.queue.push(incoming(30,'already committed'));await f.runner.pollOnce();
    assert.equal(f.store.tasks(f.bot.id).length,1);assert.equal(f.store.get<{taskId:string}>('SELECT taskId FROM telegram_updates')!.taskId,first.id);
  }finally{f.close();}
});

test('slash control commands preserve durable steering, follow-up dependencies and cancellation semantics',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(40,'task'));await f.runner.pollOnce();const task=f.store.tasks(f.bot.id)[0]!,run=f.store.claim('synthetic-worker')!;
    f.queue.push(incoming(41,`/steer ${task.id} change direction`),incoming(42,`/followup ${task.id} next step`));await f.runner.pollOnce();
    const commands=f.store.all<{type:string;text:string;state:string}>('SELECT type,text,state FROM commands');assert.deepEqual(commands.map(c=>({...c})),[{type:'steer',text:'change direction',state:'pending'}]);
    const follow=f.store.tasks(f.bot.id).find(t=>t.parentTaskId===task.id)!;assert.equal(follow.prompt,'next step');assert.equal(f.store.claim('other'),null);
    f.queue.push(incoming(43,`/cancel ${task.id}`));await f.runner.pollOnce();assert.equal(f.store.task(f.bot.id,task.id).state,'cancelling');assert.equal(f.store.task(f.bot.id,follow.id).state,'cancelled');
    assert.equal(f.store.takeCommand(run)!.type,'cancel');f.store.finish(run,'succeeded','late result',null);assert.equal(f.store.task(f.bot.id,task.id).state,'cancelled');
    f.queue.push(incoming(43,`/cancel ${task.id}`));await f.runner.pollOnce();assert.equal(f.store.all('SELECT * FROM commands').length,2);
  }finally{f.close();}
});

test('help, invalid commands, status and wrong-bot commands never create unintended work or expose raw errors',async()=>{
  const f=fixture();try{
    const other=f.store.createBot('Other'),task=f.store.submit(other.id,randomUUID(),'another bot secret');
    f.queue.push(incoming(50,'/help'),incoming(51,'/wat'),incoming(52,'/cancel'),incoming(53,`/status ${task.id}`),incoming(54,`/cancel ${task.id}`),incoming(55,'/status'));
    await f.runner.pollOnce();for(let i=0;i<6;i++){f.advance();await f.runner.flushOnce();}
    assert.equal(f.store.tasks(f.bot.id).length,0);assert.equal(f.store.task(other.id,task.id).state,'queued');
    assert.match(f.sent[0]!.text,/followup/);assert.match(f.sent[3]!.text,/not found/);assert.match(f.sent[5]!.text,/Worker offline/);assert.equal(JSON.stringify(f.sent).includes('another bot secret'),false);
  }finally{f.close();}
});

test('unsupported attachment/forwarded content and credential-like text do not enter Store tasks or channel payloads',async()=>{
  const f=fixture();try{
    f.queue.push({...incoming(60,'caption ignored'),message:{...incoming(60,'caption ignored').message,document:{file_id:'untrusted'}}},
      {...incoming(61,'forwarded'),message:{...incoming(61,'forwarded').message,forward_origin:{type:'user'}}},incoming(62,`please use ${TOKEN}`),incoming(63,'x'.repeat(4097)));
    await f.runner.pollOnce();assert.equal(f.store.tasks(f.bot.id).length,0);const persisted=JSON.stringify(f.store.all('SELECT * FROM telegram_deliveries'));
    assert.equal(persisted.includes(TOKEN),false);assert.equal(persisted.includes('file_id'),false);assert.match(persisted,/not queued/);
  }finally{f.close();}
});

test('progress and final result are projected once, bounded, plain text and sanitized',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(70,'progress'));await f.runner.pollOnce();await f.runner.flushOnce();const task=f.store.tasks(f.bot.id)[0]!,run=f.store.claim('worker')!;
    f.advance();await f.runner.flushOnce();assert.match(f.sent[1]!.text,/: running/);
    f.advance();await f.runner.flushOnce();assert.equal(f.sent.length,2);
    f.store.finish(run,'succeeded',`Safe <b>plain</b> ${TOKEN} `+'🧡'.repeat(3000),null);f.advance();await f.runner.flushOnce();
    assert.match(f.sent[2]!.text,/: succeeded/);assert.equal(f.sent[2]!.text.includes(TOKEN),false);assert.match(f.sent[2]!.text,/Truncated/);assert.ok(f.sent[2]!.text.length<=4096);assert.equal(f.sent[2]!.parse_mode,undefined);
    f.advance();await f.runner.flushOnce();assert.equal(f.sent.length,3);assert.equal(f.store.get<{terminalQueued:number}>('SELECT terminalQueued FROM telegram_tasks WHERE taskId=?',task.id)!.terminalQueued,1);
  }finally{f.close();}
});

test('queued cancel reaches terminal notification even without a worker event',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(80,'cancel me'));await f.runner.pollOnce();const task=f.store.tasks(f.bot.id)[0]!;
    f.queue.push(incoming(81,`/cancel ${task.id}`));await f.runner.pollOnce();for(let i=0;i<3;i++){f.advance();await f.runner.flushOnce();}
    assert.equal(f.store.task(f.bot.id,task.id).state,'cancelled');assert.equal(f.sent.filter(s=>s.text.includes(': cancelled')).length,1);assert.equal(f.store.claim('worker'),null);
  }finally{f.close();}
});

test('network-ambiguous send is durable uncertain and is never retried, even after restart',async()=>{
  const f=fixture();try{
    f.setSend(async()=>{throw new Error(`request URL leaked ${TOKEN}`);});f.queue.push(incoming(90,'one'));await f.runner.pollOnce();await f.runner.flushOnce();
    assert.deepEqual({...f.store.get<Record<string,unknown>>('SELECT state,errorKind,attempts FROM telegram_deliveries')},{state:'uncertain',errorKind:'network',attempts:1});
    f.advance();await f.runner.flushOnce();assert.equal(f.sent.length,1);assert.equal(JSON.stringify(f.store.all('SELECT * FROM telegram_deliveries')).includes(TOKEN),false);
    f.runner.close();const next=new TelegramChannelRunner(f.store,f.config,{fetch:f.fetcher});next.start();try{await next.flushOnce();assert.equal(f.sent.length,1);}finally{next.close();}
  }finally{f.close();}
});

test('crash during send becomes uncertain when lease is recovered; no duplicate Telegram message is attempted',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(100,'one'));await f.runner.pollOnce();f.store.db.prepare("UPDATE telegram_deliveries SET state='sending',attempts=1").run();f.runner.close();
    const next=new TelegramChannelRunner(f.store,f.config,{fetch:f.fetcher});next.start();try{await next.flushOnce();assert.equal(f.sent.length,0);assert.equal(f.store.get<{state:string}>('SELECT state FROM telegram_deliveries')!.state,'uncertain');}finally{next.close();}
  }finally{f.close();}
});

test('explicit 429 safely retries after its deadline, with a bounded attempt count and no duplicate task',async()=>{
  const f=fixture();try{
    f.setSend(async()=>failure(429,{parameters:{retry_after:2}}));f.queue.push(incoming(110,'one'));await f.runner.pollOnce();await f.runner.flushOnce();
    assert.equal(f.store.get<{state:string}>('SELECT state FROM telegram_deliveries')!.state,'pending');
    f.advance();await f.runner.flushOnce();assert.equal(f.sent.length,1);
    for(let i=0;i<4;i++){f.advance();f.advance();await f.runner.flushOnce();}
    assert.equal(f.sent.length,5);assert.deepEqual({...f.store.get<Record<string,unknown>>('SELECT state,errorKind,attempts FROM telegram_deliveries')},{state:'failed',errorKind:'rate_limited',attempts:5});assert.equal(f.store.tasks(f.bot.id).length,1);
  }finally{f.close();}
});

test('definitive failed delivery and wrong/malformed acknowledgement never claim success',async()=>{
  for(const answer of [()=>failure(400),()=>failure(500),()=>response({message_id:12,chat:{id:999}})]){
    const f=fixture();try{f.setSend(async()=>answer());f.queue.push(incoming(120,'one'));await f.runner.pollOnce();await f.runner.flushOnce();const state=f.store.get<{state:string}>('SELECT state FROM telegram_deliveries')!.state;assert.notEqual(state,'sent');assert.equal(state,answer().status===400?'failed':'uncertain');}finally{f.close();}
  }
});

test('single poller lease and immutable binding reject competing processes and accidental retargeting',()=>{
  const f=fixture();try{
    const other=new TelegramChannelRunner(f.store,f.config,{fetch:f.fetcher});assert.throws(()=>other.start(),/already running/);
    assert.throws(()=>new TelegramChannelRunner(f.store,{...f.config,chatId:'9001'},{fetch:f.fetcher}),/binding changed/);
    assert.equal(f.store.get<{chatId:string}>('SELECT chatId FROM telegram_channel')!.chatId,'7001');
  }finally{f.close();}
});

test('transport bounds replies and drops tokens from provider, redirect, malformed JSON and network errors',async()=>{
  for(const impl of [async()=>failure(401),async()=>new Response('x'.repeat(1_048_577)),async()=>new Response('not json'),async()=>{throw new Error(TOKEN);}]){
    const transport=new TelegramTransport(TOKEN,impl);await assert.rejects(transport.call('getUpdates',{},new AbortController().signal),error=>{assert.ok(error instanceof TelegramError);assert.equal(String(error).includes(TOKEN),false);return true;});
  }
});

test('run uses bounded poll backoff, remains cancellable, and shuts down without replay',async()=>{
  const store=new Store(':memory:'),bot=store.createBot('Retry'),config=telegramConfig(environment(bot.id))!,waits:number[]=[];let polls=0;
  let runner:TelegramChannelRunner;
  runner=new TelegramChannelRunner(store,config,{fetch:async()=>{polls++;throw new Error(TOKEN);},sleep:async(ms,signal)=>{
    if(ms>=1000){waits.push(ms);if(waits.length===7)runner.stop();return;}
    await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
  }});
  try{await runner.run();assert.deepEqual(waits,[1000,2000,4000,8000,16000,30000,30000]);assert.equal(polls,7);assert.equal(store.get<{status:string}>('SELECT status FROM telegram_channel')!.status,'stopped');assert.equal(JSON.stringify(store.all('SELECT * FROM telegram_channel')).includes(TOKEN),false);}finally{store.close();}
});

test('unauthorized polling stops safely without retry and exposes only a bounded reason',async()=>{
  const store=new Store(':memory:'),bot=store.createBot('Unauthorized');let calls=0;
  const runner=new TelegramChannelRunner(store,telegramConfig(environment(bot.id))!,{fetch:async()=>{calls++;return failure(401);}});
  try{await runner.run();assert.equal(calls,1);assert.deepEqual({...store.get<Record<string,unknown>>('SELECT status,lastError,leaseUntil FROM telegram_channel')},{status:'blocked',lastError:'unauthorized',leaseUntil:0});}finally{store.close();}
});

test('shutdown aborts an in-flight long poll and settles the channel without advancing the cursor',async()=>{
  const store=new Store(':memory:'),bot=store.createBot('Stop');let began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const runner=new TelegramChannelRunner(store,telegramConfig(environment(bot.id))!,{fetch:async(_url,init)=>{
    began();return await new Promise<Response>((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new Error(TOKEN)),{once:true});});
  }});
  try{const work=runner.run();await started;runner.stop();await work;assert.equal(store.get<{nextOffset:number}>('SELECT nextOffset FROM telegram_channel')!.nextOffset,0);assert.equal(store.get<{status:string}>('SELECT status FROM telegram_channel')!.status,'stopped');}finally{store.close();}
});

test('storage failure before checkpoint leaves update unacknowledged and replay completes one task and receipt',async()=>{
  const f=fixture();try{
    f.store.db.exec("CREATE TRIGGER telegram_test_failure BEFORE INSERT ON telegram_updates BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END;");
    f.queue.push(incoming(130,'commit then fail'));await assert.rejects(f.runner.pollOnce(),/synthetic checkpoint failure/);
    assert.equal(f.store.tasks(f.bot.id).length,1);assert.equal(f.store.get<{nextOffset:number}>('SELECT nextOffset FROM telegram_channel')!.nextOffset,0);assert.equal(f.store.all('SELECT * FROM telegram_deliveries').length,0);
    f.store.db.exec('DROP TRIGGER telegram_test_failure');f.queue.push(incoming(130,'commit then fail'));await f.runner.pollOnce();await f.runner.flushOnce();
    assert.equal(f.store.tasks(f.bot.id).length,1);assert.equal(f.sent.length,1);assert.equal(f.store.get<{nextOffset:number}>('SELECT nextOffset FROM telegram_channel')!.nextOffset,131);
  }finally{f.close();}
});

test('malformed updates cannot skip the durable offset or persist arbitrary messages',async()=>{
  const f=fixture();try{
    f.queue.push(incoming(140,'valid but batch rejected'),{update_id:'141',message:incoming(141,'bad').message});
    await assert.rejects(f.runner.pollOnce(),/invalid_response/);assert.equal(f.store.tasks(f.bot.id).length,0);assert.equal(f.store.get<{nextOffset:number}>('SELECT nextOffset FROM telegram_channel')!.nextOffset,0);
  }finally{f.close();}
});

test('delivery backlog applies bounded ingress backpressure without acknowledging more updates',async()=>{
  const f=fixture();try{
    const stmt=f.store.db.prepare("INSERT INTO telegram_deliveries(dedupeKey,text) VALUES (?,?)");for(let i=0;i<200;i++)stmt.run(`synthetic:${i}`,'pending');
    f.queue.push(incoming(150,'wait for delivery'));await f.runner.pollOnce();assert.equal(f.calls.length,0);assert.equal(f.store.tasks(f.bot.id).length,0);assert.equal(f.queue.length,1);
  }finally{f.close();}
});
