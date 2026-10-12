import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store.ts';
import { config,prepareStorage } from '../src/config.ts';
import { Worker,type AdapterFactory,type WorkerDependencies } from '../src/worker.ts';
async function until(fn:()=>boolean){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw new Error('Timed out');await sleep(20);}}
async function fixture(factory:AdapterFactory,deps:WorkerDependencies={}){
  const root=await mkdtemp(join(tmpdir(),'cn-persist-worker-'));const c=config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'persistent',CHESTNUT_EXPERIMENTAL_PERSISTENT:'1',CHESTNUT_DATA_DIR:root,OPENAI_API_KEY:'test-only-not-a-credential'});
  // This fixture stubs every gateway/Docker operation; use a canonical local directory
  // so macOS can exercise Worker state transitions without claiming Linux transport coverage.
  c.gatewayRoot=join(root,'mock-gateways');prepareStorage(c);const s=new Store(c.dbPath),b=s.createBot('Persistent test');
  const worker=new Worker(s,c,factory,{acquireLock:async()=>{let held=true;return{isHeld:()=>held,release:async()=>{held=false;},runner:{command:async()=>{throw new Error('No real Docker allowed in test');},attach:()=>{throw new Error('No real Docker allowed in test');}}};},gateway:async()=>({close:async()=>{}}),memoryBroker:async()=>({close:async()=>{}}),cleanupPersistent:async()=>{},...deps});
  const running=worker.run();return{s,b,async close(){await worker.stop();await running;s.close();await rm(root,{recursive:true,force:true});await rm(c.gatewayRoot,{recursive:true,force:true});}};
}
test('persistent launch failure before transport still requires host stop; unknown cleanup quarantines',async()=>{
  let cleanup=0,started=false;const f=await fixture(()=>({async start(){started=true;throw new Error('Started bot but failed to return transport');},async steer(){},async cancel(){},async dispose(){}}),{cleanupPersistent:async()=>{cleanup++;if(cleanup>1)throw new Error('Stop could not be confirmed');}});
  try{const task=f.s.submit(f.b.id,randomUUID(),'persistent change');const follow=f.s.command(f.b.id,task.id,randomUUID(),'follow_up','dependent');await until(()=>f.s.task(f.b.id,task.id).state==='interrupted');assert.equal(started,true);assert.ok(cleanup>=2);assert.equal(f.s.quarantines().length,1);assert.equal(f.s.environment(f.b.id)?.state,'quarantined');assert.equal(f.s.task(f.b.id,follow.id).state,'cancelled');}finally{await f.close();}
});
test('persistent finally stop sees recorded immutable identity and preserves environment record',async()=>{
  let f:Awaited<ReturnType<typeof fixture>>,checked=false;
  f=await fixture(()=>({async start(_i,emit){f.s.observeEnvironment(f.b.id,{containerId:'container-A',imageId:'image-A',state:'running'});emit({type:'message_end',data:{message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}}});emit({type:'agent_settled',data:{aborted:false}});},async steer(){},async cancel(){},async dispose(){}}),{cleanupPersistent:async(_input,options)=>{assert.equal(options.canMutate(),true);if(options.expectedContainerId){assert.equal(options.expectedContainerId,'container-A');assert.equal(options.expectedImageId,'image-A');checked=true;}}});
  try{const task=f.s.submit(f.b.id,randomUUID(),'persistent change');await until(()=>f.s.task(f.b.id,task.id).state==='succeeded');assert.ok(checked);assert.equal(f.s.environment(f.b.id)?.containerId,'container-A');assert.equal(f.s.environment(f.b.id)?.state,'stopped');}finally{await f.close();}
});
test('persistent startup/readiness failure is an unknown outcome even before prompt dispatch',async()=>{
  const f=await fixture(()=>({async start(){throw new Error('Guest startup ran; Pi readiness lost');},async steer(){},async cancel(){},async dispose(){}}));
  try{const task=f.s.submit(f.b.id,randomUUID(),'start guest');const follow=f.s.command(f.b.id,task.id,randomUUID(),'follow_up','dependent');await until(()=>f.s.task(f.b.id,task.id).state==='interrupted');assert.equal(f.s.task(f.b.id,follow.id).state,'cancelled');assert.equal(f.s.quarantines().length,0);}finally{await f.close();}
});

test('persistent old guest is stopped before a new gateway capability is published',async()=>{
  const order:string[]=[];const f=await fixture(()=>({async start(_i,emit){order.push('launch');emit({type:'agent_settled',data:{aborted:false}});},async steer(){},async cancel(){},async dispose(){}}),{cleanupPersistent:async()=>{order.push('verified-stop');},gateway:async()=>{order.push('gateway');return{close:async()=>{order.push('gateway-close');}};}});
  try{const task=f.s.submit(f.b.id,randomUUID(),'new capability');await until(()=>f.s.task(f.b.id,task.id).state==='succeeded');assert.deepEqual(order.slice(0,3),['verified-stop','gateway','launch']);}finally{await f.close();}
});
