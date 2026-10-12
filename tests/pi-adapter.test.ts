import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpcAdapter } from '../src/pi/rpc-adapter.ts';
import { FakeAdapter } from '../src/pi/fake-adapter.ts';
import { CommandUncertainError } from '../src/pi/types.ts';
import type { RpcTransport, WorkerEvent, WorkerInput } from '../src/pi/types.ts';

const input: WorkerInput = { botId:'b', taskId:'t', runId:'r', prompt:'hello', workspace:'/data/bots/b/workspace', sessionPath:'/data/sessions/t/session.jsonl' };
class MockTransport implements RpcTransport {
  commands: Record<string,unknown>[] = [];
  stopped = false;
  line: (line:string)=>void = () => {};
  closed: (error?:Error)=>void = () => {};
  async write(line:string):Promise<void> { const command=JSON.parse(line); this.commands.push(command); if(command.type==='get_state')queueMicrotask(()=>this.event({type:'response',id:command.id,command:'get_state',success:true,data:{isStreaming:false}})); }
  onLine(listener:(line:string)=>void):void { this.line=listener; }
  onClose(listener:(error?:Error)=>void):void { this.closed=listener; }
  async stop():Promise<void> { this.stopped=true; }
  event(value:unknown):void { this.line(JSON.stringify(value)); }
}
const flush = () => delay(0);
test('RPC ACK and agent_end do not settle the run; only agent_settled does', async()=>{
  const transport = new MockTransport(); const adapter = new PiRpcAdapter({launch:async()=>transport});
  let settled=false; const events: WorkerEvent[]=[];
  const run = adapter.start(input,e=>events.push(e)).then(()=>{settled=true;});
  await flush(); transport.event({type:'response',id:'r',command:'prompt',success:true,data:{disposition:'started'}});
  transport.event({type:'agent_end',willRetry:true}); await flush(); assert.equal(settled,false);
  transport.event({type:'agent_settled',aborted:false}); await run; assert.equal(settled,true); assert.equal(events.length,6);
  await adapter.dispose();
});
test('handled prompt does not hang or count as a completed agent run', async()=>{
  const transport=new MockTransport(); const adapter=new PiRpcAdapter({launch:async()=>transport});
  const run=adapter.start(input,()=>{}); const check=assert.rejects(run,/without starting/);
  await flush(); transport.event({type:'response',id:'r',command:'prompt',success:true,data:{disposition:'handled'}});
  await check; await adapter.dispose();
});
test('steer is acknowledged once, with no implicit replay on lost ACK', async()=>{
  const transport=new MockTransport(); const adapter=new PiRpcAdapter({launch:async()=>transport},{ackTimeoutMs:25});
  const run=adapter.start(input,()=>{}); void run.catch(()=>{});
  await flush(); transport.event({type:'response',id:'r',command:'prompt',success:true});
  await assert.rejects(adapter.steer('m1','direction'),CommandUncertainError);
  assert.equal(transport.commands.filter(c=>c.id==='m1').length,1);
  transport.event({type:'agent_settled',aborted:false}); await run; await adapter.dispose();
});
test('transport close rejects active run and never resends prompt',async()=>{
  const transport=new MockTransport(); const adapter=new PiRpcAdapter({launch:async()=>transport});
  const run=adapter.start(input,()=>{}); const check=assert.rejects(run,/closed/);
  await flush(); transport.closed(new Error('closed'));
  await check; assert.equal(transport.commands.filter(c=>c.type==='prompt').length,1); await adapter.dispose();
});
test('cancel sends all abort controls and destroys container',async()=>{
  const transport=new MockTransport(); const adapter=new PiRpcAdapter({launch:async()=>transport},{ackTimeoutMs:10});
  const run=adapter.start(input,()=>{}); void run.catch(()=>{}); await flush();
  transport.event({type:'response',id:'r',command:'prompt',success:true});
  await adapter.cancel(); await assert.rejects(run,/cancelled/);
  assert.deepEqual(transport.commands.slice(2).map(c=>c.type).sort(),['abort','abort_bash','abort_retry','clear_queue']);
  assert.equal(transport.stopped,true); await assert.rejects(adapter.steer('m','later'),/not accepting/);
});
test('fake demo is deterministic and marks events as demonstration',async()=>{
  const fake=new FakeAdapter({delayMs:5}); const events:WorkerEvent[]=[];
  await fake.start(input,e=>events.push(e));
  assert.deepEqual(events.map(e=>e.type),['response','agent_start','message_update','message_end','agent_end','agent_settled']);
  assert.deepEqual(events.at(-1)?.data,{aborted:false,demo:true}); await fake.dispose();
});

test('readiness is acknowledged before lease fence permits prompt',async()=>{
  const transport=new MockTransport();
  const adapter=new PiRpcAdapter({launch:async()=>transport},{beforePrompt:()=>{throw new Error('Lease expired');}});
  await assert.rejects(adapter.start(input,()=>{}),/Lease expired/);
  assert.deepEqual(transport.commands.map(c=>c.type),['get_state']); await adapter.dispose();
});

test('event sink failure rejects run for fenced disposal instead of crashing host',async()=>{
  const transport=new MockTransport();const adapter=new PiRpcAdapter({launch:async()=>transport});
  const run=adapter.start(input,()=>{throw new Error('Event store failed');});
  await assert.rejects(run,/Event store failed/);await adapter.dispose();assert.equal(transport.stopped,true);
});
test('failed sandbox cleanup rejects cancellation and remains retryable',async()=>{
  const transport=new MockTransport();let attempts=0;
  transport.stop=async()=>{attempts++;if(attempts===1)throw new Error('daemon unavailable');transport.stopped=true;};
  const adapter=new PiRpcAdapter({launch:async()=>transport},{ackTimeoutMs:10});
  const run=adapter.start(input,()=>{});void run.catch(()=>{});await flush();
  transport.event({type:'response',id:'r',command:'prompt',success:true});
  await assert.rejects(adapter.cancel(),/daemon unavailable/);await assert.rejects(run,/cancelled/);
  await adapter.dispose();assert.equal(attempts,2);assert.equal(transport.stopped,true);
});

test('lost prompt ACK and no settlement remain uncertain with one dispatch and no replay',async()=>{
  const transport=new MockTransport();const events:WorkerEvent[]=[];
  const adapter=new PiRpcAdapter({launch:async()=>transport},{ackTimeoutMs:15});
  await assert.rejects(adapter.start(input,event=>events.push(event)),CommandUncertainError);
  assert.equal(transport.commands.filter(command=>command.type==='prompt').length,1);
  assert.deepEqual(events.filter(event=>event.type==='command_dispatch'&&(event.data as Record<string,unknown>).command==='prompt'),[{type:'command_dispatch',data:{id:'r',command:'prompt'}}]);
  assert.equal(events.some(event=>event.type==='agent_settled'),false);await adapter.dispose();
});
