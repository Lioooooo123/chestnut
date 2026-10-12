import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {AuthManager} from '../src/auth.ts';
import {config,prepareStorage} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Worker} from '../src/worker.ts';
import {FakeAdapter} from '../src/pi/fake-adapter.ts';
import type {ModelGatewayOptions} from '../src/gateway/index.ts';
async function until(predicate:()=>boolean){const deadline=Date.now()+6000;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out');await sleep(20);}}

test('synthetic Worker grant is revoked after identity switch and cannot expose the new account credential',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'cn-worker-grant-'));
  const c=config({CHESTNUT_DATA_DIR:root,CHESTNUT_MODE:'pi',CHESTNUT_MEMORY_AUTOMATIC:'0',CHESTNUT_MODEL:'configured-model'});prepareStorage(c);
  let account=1,closed=0;
  const auth=new AuthManager(join(root,'control','auth'),{async login(){return {type:'oauth',access:`synthetic-account-${account}`,refresh:'synthetic-refresh',expires:Date.now()+3600000,clientId:'synthetic-client',scopes:['chatgpt.tokens.use.direct']};},async refresh(value){return value;}});
  await auth.startLogin(randomUUID());await auth.wait();
  const store=new Store(c.dbPath),bot=store.createBot('Grant regression');let gatewayOptions:ModelGatewayOptions|undefined;
  // Explicit unit seams only: this regression opens no socket, container or model connection.
  const worker=new Worker(store,c,()=>new FakeAdapter({delayMs:30000}),{
    gateway:async options=>{gatewayOptions=options;return {async close(){closed++;}};},
    memoryBroker:async()=>({async close(){}}),
  });
  const running=worker.run();
  try{
    const task=store.submit(bot.id,randomUUID(),'Keep this synthetic context on its original grant.');
    await until(()=>!!gatewayOptions&&store.events(bot.id,task.id).some(event=>event.type==='pi.agent_start'));
    const gateway=gatewayOptions!;
    assert.equal(gateway.authorize!(),true);assert.equal(await gateway.getApiKey!(new AbortController().signal),'synthetic-account-1');
    account=2;await auth.startLogin(randomUUID());await auth.wait();
    assert.equal(gateway.authorize!(),false);
    await assert.rejects(gateway.getApiKey!(new AbortController().signal),/changed/);
    await until(()=>store.task(bot.id,task.id).state==='interrupted');assert.ok(closed>0);
    assert.equal(await auth.apiKey(),'synthetic-account-2','the new grant is usable only by new work');
    assert.ok(!JSON.stringify(store.events(bot.id,task.id)).includes('synthetic-account-'));
  }finally{await worker.stop();await running;auth.close();store.close();await rm(root,{recursive:true,force:true});}
});
