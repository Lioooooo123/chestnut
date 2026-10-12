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
