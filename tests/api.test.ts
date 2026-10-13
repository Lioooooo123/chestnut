import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { createApi } from '../src/api.ts';
import { config } from '../src/config.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('desktop/snapshot API remains declarative, Bot scoped and explicit about file restore',async()=>{
  const s=new Store(':memory:'),c=config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'service',CHESTNUT_EXPERIMENTAL_SERVICE:'1',CHESTNUT_DESKTOP_ENABLED:'1'}),api=createApi(s,c);
  try{const bot=s.createBot('Desktop'),other=s.createBot('Other'),base=`/api/bots/${bot.id}`,requestId=randomUUID(),snapshotId=randomUUID();s.db.prepare('INSERT INTO environment_snapshots VALUES(?,?,?,?,?)').run(snapshotId,bot.id,JSON.stringify({id:snapshotId,botId:bot.id,format:1}),'fixture-hash',Date.now());
    assert.equal((await request(api,'POST',base+'/snapshots',{requestId,action:'restore',snapshotId})).status,409);
    assert.equal((await request(api,'POST',`/api/bots/${other.id}/snapshots`,{requestId,action:'restore',snapshotId,confirmed:true})).status,404);
    assert.equal((await request(api,'POST',base+'/desktop',{requestId,op:'click'})).status,400);
    assert.equal((await request(api,'POST',base+'/snapshots',{requestId,action:'restore',snapshotId,confirmed:true})).status,202);
    assert.equal((await request(api,'POST',base+'/snapshots',{requestId,action:'restore',snapshotId,confirmed:true})).status,202);
    assert.equal(s.get<any>('SELECT count(*) count FROM environment_operations').count,1);assert.equal(s.get<any>('SELECT * FROM environment_operations').state,'queued');
    assert.equal((await request(api,'POST',base+'/tasks',{messageId:randomUUID(),prompt:'wait'})).status,409);
    assert.equal((await request(api,'GET',base+'/desktop/frame?session='+randomUUID())).status,404);
    const session=randomUUID();s.db.prepare("INSERT INTO desktop_sessions VALUES(?,?,'running','about:blank',?,?,NULL)").run(bot.id,session,Date.now(),Buffer.from('fixture PNG bytes, not an image test').toString('base64'));
    assert.equal((await request(api,'GET',base+'/desktop/frame?session='+randomUUID())).status,409);assert.equal((await request(api,'GET',base+'/desktop/frame?session='+session)).status,200);
    assert.equal((await request(api,'GET',`/api/bots/${other.id}/desktop/frame?session=${session}`)).status,404);
    assert.equal((await request(api,'GET',base+'/desktop/frame?session='+session,undefined,{origin:'https://attacker.example'})).status,403);
    const status=JSON.parse((await request(api,'GET',base+'/desktop')).body);assert.equal(Object.hasOwn(status.session,'png'),false);assert.equal(Object.hasOwn(status,'token'),false);
  }finally{api.close();s.close();}
});

test('Bot creation receipts deduplicate and task/command receipts read current state without mutation',async()=>{
  const s=new Store(':memory:'),api=createApi(s,config());
  try{
    const requestId=randomUUID(),b=JSON.parse((await request(api,'POST','/api/bots',{name:'Recovery',requestId})).body);
    assert.equal(JSON.parse((await request(api,'POST','/api/bots',{name:'Recovery',requestId})).body).id,b.id);
    assert.equal((await request(api,'POST','/api/bots',{name:'Different',requestId})).status,409);
    assert.equal(JSON.parse((await request(api,'GET',`/api/bot-requests/${requestId}`)).body).id,b.id);
    assert.equal((await request(api,'GET',`/api/bot-requests/${randomUUID()}`)).status,404);
    const messageId=randomUUID(),t=s.submit(b.id,messageId,'one'),run=s.claim('fixture')!;
    const steerId=randomUUID(),cmd=s.command(b.id,t.id,steerId,'steer','direction');
    const sending=s.takeCommand(run)!;s.finishCommand(run,sending.id,true);s.finish(run,'succeeded','result',null);
    const before=s.changes().length;
    const receipt=JSON.parse((await request(api,'GET',`/api/bots/${b.id}/requests/${messageId}`)).body);
    assert.equal(receipt.payload.prompt,'one');assert.equal(receipt.response.state,'succeeded');assert.equal(receipt.response.result,'result');
    const command=JSON.parse((await request(api,'GET',`/api/bots/${b.id}/requests/${steerId}`)).body);
    assert.equal(command.response.id,cmd.id);assert.equal(command.response.state,'sent_unconfirmed');
    const other=s.createBot('Other');assert.equal((await request(api,'GET',`/api/bots/${other.id}/requests/${messageId}`)).status,404);
    assert.equal((await request(api,'GET',`/api/bots/${b.id}/requests/not-a-uuid`)).status,400);
    assert.equal(s.changes().length,before);assert.equal(s.tasks(b.id).length,1);
  }finally{api.close();s.close();}
});
// Real Node HTTP parser/handler over paired in-memory streams. No OS listener.
class MemorySocket extends Duplex {
  peer!:MemorySocket; connecting=false;
  _read(){} _write(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null)=>void){this.peer.push(chunk);callback();}
  _final(callback:()=>void){this.peer.push(null);callback();}
  _destroy(error:Error|null,callback:(error:Error|null)=>void){if(!this.peer.destroyed)this.peer.destroy();callback(error);}
  setTimeout(){return this;} setNoDelay(){return this;} setKeepAlive(){return this;} ref(){return this;} unref(){return this;}
}
async function request(server:ReturnType<typeof createApi>,method:string,url:string,value?:unknown,headers:Record<string,string>={},chunks?:Buffer[]){
  const client=new MemorySocket(),host=new MemorySocket();client.peer=host;host.peer=client;server.emit('connection',host);
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=httpRequest({method,path:url,host:'127.0.0.1',port:4310,headers:{host:'127.0.0.1:4310','content-type':'application/json',...(value===undefined||chunks?{}:{'content-length':String(Buffer.byteLength(JSON.stringify(value)))}),...headers},agent:undefined,createConnection:()=>client as unknown as Socket},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,body}));
    });req.on('error',reject);if(chunks){for(const chunk of chunks)req.write(chunk);req.end();}else req.end(value===undefined?undefined:JSON.stringify(value));
  });
}
test('API handler create/chat/events/idempotency/cross-bot validation',async()=>{const s=new Store(':memory:'),api=createApi(s,config());try{const b=JSON.parse((await request(api,'POST','/api/bots',{name:'Chestnut'})).body);const id=randomUUID();const response=await request(api,'POST',`/api/bots/${b.id}/tasks`,{messageId:id,prompt:'hello'});assert.equal(response.status,202);const task=JSON.parse(response.body);assert.equal(JSON.parse((await request(api,'POST',`/api/bots/${b.id}/tasks`,{messageId:id,prompt:'hello'})).body).id,task.id);assert.equal((await request(api,'POST',`/api/bots/${b.id}/tasks`,{messageId:id,prompt:'changed'})).status,409);assert.equal(JSON.parse((await request(api,'GET',`/api/bots/${b.id}/tasks/${task.id}/events`)).body).length,1);const other=s.createBot('Other');assert.equal((await request(api,'GET',`/api/bots/${other.id}/tasks/${task.id}`)).status,404);}finally{s.close();api.close();}});
test('API rejects DNS rebinding, cross-origin writes, non-JSON, invalid cursor and path',async()=>{const s=new Store(':memory:'),api=createApi(s,config());try{assert.equal((await request(api,'GET','/api/status',undefined,{host:'attacker.example:4310'})).status,403);assert.equal((await request(api,'POST','/api/bots',{name:'bad'},{origin:'https://evil.example'})).status,403);assert.equal((await request(api,'POST','/api/bots',{name:'bad'},{'content-type':'text/plain'})).status,415);assert.equal((await request(api,'GET','/api/events?after=NaN')).status,400);assert.equal((await request(api,'GET','/api/bots/%2e%2e/tasks')).status,404);}finally{s.close();api.close();}});
test('API exposes worker offline and demo status without invoking a worker',async()=>{const s=new Store(':memory:'),api=createApi(s,config());try{const status=JSON.parse((await request(api,'GET','/api/status')).body);assert.equal(status.worker.online,false);assert.equal(status.mode,'demo');assert.equal(status.concurrency,1);}finally{s.close();api.close();}});

test('API preserves Chinese and emoji across split UTF-8 body chunks',async()=>{const s=new Store(':memory:'),api=createApi(s,config());try{const value=Buffer.from(JSON.stringify({name:'栗子🌰'}));const response=await request(api,'POST','/api/bots',undefined,{},Array.from(value,byte=>Buffer.from([byte])));assert.equal(response.status,201);assert.equal(JSON.parse(response.body).name,'栗子🌰');}finally{s.close();api.close();}});

test('memory API persists corrections, rejects cross-bot sources and reports stale edits without overwriting', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chestnut-memory-api-'));
  const s = new Store(':memory:'), api = createApi(s, config({ CHESTNUT_DATA_DIR: root }));
  try {
    const bot = s.createBot('Chestnut'), other = s.createBot('Other');
    const task = s.submit(other.id, randomUUID(), 'Another bot task');
    const path = `/api/bots/${bot.id}/memory`;
    const input = { requestId: randomUUID(), title: 'Testing', content: '先写测试，再实现。', scope: 'bot', kind: 'correction' };
    assert.equal((await request(api, 'POST', path, { ...input, sourceTaskId: task.id })).status, 404);
    const response = await request(api, 'POST', path, input); assert.equal(response.status, 201);
    const saved = JSON.parse(response.body);
    const updated = await request(api, 'PATCH', `${path}/${saved.id}`, { requestId: randomUUID(), expectedRevision: saved.entry.revision, title: input.title, content: '测试通过后再交付。' });
    assert.equal(updated.status, 200);
    assert.equal((await request(api, 'PATCH', `${path}/${saved.id}`, { requestId: randomUUID(), expectedRevision: saved.entry.revision, title: input.title, content: 'Stale edit' })).status, 409);
    assert.equal(JSON.parse((await request(api, 'GET', `${path}?q=${encodeURIComponent('交付')}`)).body).entries[0]?.content, '测试通过后再交付。');
    assert.equal(JSON.parse((await request(api, 'GET', `/api/bots/${other.id}/memory`)).body).entries.length, 0);
    assert.equal((await request(api, 'DELETE', `${path}/${saved.id}`, { requestId: randomUUID(), expectedRevision: JSON.parse(updated.body).entry.revision })).status, 200);
  } finally { api.close(); s.close(); rmSync(root, { recursive: true, force: true }); }
});
test('maintenance API queues idempotent Dreaming and exposes sourced conflicts without running models in the API', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-maint-api-')); const s = new Store(':memory:'); const api = createApi(s,config({ CHESTNUT_DATA_DIR: root }));
  try { const bot = s.createBot('Memory'); const path = `/api/bots/${bot.id}/memory/maintenance`;
    assert.equal((await request(api,'GET',path)).status,200);
    const id = randomUUID(); assert.equal((await request(api,'POST',path,{ requestId:id })).status,202);
    assert.equal((await request(api,'POST',path,{ requestId:id })).status,202);
    assert.equal((await request(api,'POST',path,{ requestId:randomUUID() })).status,409);
    const status = JSON.parse((await request(api,'GET',path)).body); assert.equal(status.job.requested,id); assert.equal(status.progress.cursor,0);
    assert.equal((await request(api,'DELETE',path,{ requestId:randomUUID(),id:randomUUID() })).status,404);
  } finally { api.close(); s.close(); rmSync(root,{recursive:true,force:true}); }
});
test('ChatGPT API starts the outer flow, exposes safe status and logout clears the saved grant',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'cn-auth-api-'));const s=new Store(':memory:');
 const api=createApi(s,config({CHESTNUT_DATA_DIR:root}),{oauthFlow:{async login(){return {type:'oauth',access:'hidden-access',refresh:'hidden-refresh',expires:Date.now()+3600000,clientId:'issued-client',scopes:['chatgpt.tokens.use.direct']};},async refresh(c){return c;}}});
 try{assert.equal((await request(api,'GET','/api/auth')).status,200);const id=randomUUID();assert.equal((await request(api,'POST','/api/auth/chatgpt',{requestId:id})).status,202);
  const status=await request(api,'GET','/api/auth');assert.equal(JSON.parse(status.body).connected,true);assert.ok(!status.body.includes('hidden-access'));assert.ok(!status.body.includes('hidden-refresh'));
  assert.equal((await request(api,'DELETE','/api/auth',{})).status,200);assert.equal(JSON.parse((await request(api,'GET','/api/auth')).body).connected,false);
 }finally{api.close();s.close();rmSync(root,{recursive:true,force:true});}
});

test('runtime APIs manage durable schedules and revision-checked operator policy without exposing channel secrets',async()=>{
  const s=new Store(':memory:'),api=createApi(s,config());try{
    const bot=s.createBot('Managed'),other=s.createBot('Other'),base=`/api/bots/${bot.id}`;
    const status=JSON.parse((await request(api,'GET','/api/status')).body);assert.equal(status.capabilities.liveVerified,false);assert.ok(status.channels.telegram);assert.ok(!('token' in status.channels.telegram));
    const initial=JSON.parse((await request(api,'GET',`${base}/environment`)).body);assert.equal(initial.policy.revision,'none');assert.deepEqual(initial.policy.allowedPackages,[]);
    const policy={expectedRevision:'none',allowedPackages:['jq'],allowedHosts:['example.org']};const saved=await request(api,'PUT',`${base}/environment/policy`,policy);assert.equal(saved.status,200);
    assert.equal((await request(api,'PUT',`${base}/environment/policy`,policy)).status,409);
    assert.equal((await request(api,'PUT',`${base}/environment/policy`,{expectedRevision:JSON.parse(saved.body).revision,allowedPackages:[],allowedHosts:['*.example.org']})).status,400);
    const input={requestId:randomUUID(),name:'Review',prompt:'Summarize local progress',kind:'once',runAt:Date.now()+60000,timeZone:'UTC'};
    const created=await request(api,'POST',`${base}/schedules`,input);assert.equal(created.status,201);const schedule=JSON.parse(created.body);
    assert.equal(JSON.parse((await request(api,'POST',`${base}/schedules`,input)).body).id,schedule.id);
    assert.equal((await request(api,'POST',`${base}/schedules/${schedule.id}/pause`,{})).status,200);
    assert.equal((await request(api,'POST',`${base}/schedules/${schedule.id}/resume`,{})).status,200);
    assert.equal((await request(api,'GET',`${base}/schedules/${schedule.id}/history`)).status,200);
    assert.equal((await request(api,'POST',`/api/bots/${other.id}/schedules/${schedule.id}/pause`,{})).status,404);
    assert.equal((await request(api,'DELETE',`${base}/schedules/${schedule.id}`,{})).status,200);
    assert.equal((await request(api,'POST',`${base}/environment/stop`,{requestId:randomUUID()})).status,409);
  }finally{api.close();s.close();}
});

test('replaying a completed environment-stop request never cancels a newer task',async()=>{
  const {EnvironmentPolicies}=await import('../src/environments/policy.ts');
  const s=new Store(':memory:'),api=createApi(s,config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'service',CHESTNUT_EXPERIMENTAL_SERVICE:'1'}));
  try{const bot=s.createBot('Service'),policies=new EnvironmentPolicies(s),path=`/api/bots/${bot.id}/environment/stop`,requestId=randomUUID();
    const first=s.submit(bot.id,randomUUID(),'First'),run=s.claim('fixture')!;
    assert.equal((await request(api,'POST',path,{requestId})).status,202);assert.equal(s.task(bot.id,first.id).state,'cancelling');
    s.finish(run,'cancelled',null,null);policies.finishStop(bot.id,requestId);
    const second=s.submit(bot.id,randomUUID(),'Second');s.claim('fixture');
    const replay=await request(api,'POST',path,{requestId});assert.equal(replay.status,202);assert.equal(JSON.parse(replay.body).replayed,true);assert.equal(s.task(bot.id,second.id).state,'running');
  }finally{api.close();s.close();}
});
