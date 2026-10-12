import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

test('demo launcher refuses unrecognized data before initializing it',()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'chestnut-demo-guard-'));
  try{writeFileSync(join(dir,'keep.txt'),'existing');const result=spawnSync(process.execPath,['scripts/demo-ui.mjs','--data-dir',dir],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/Refusing non-demo/);assert.deepEqual(readdirSync(dir),['keep.txt']);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('loopback MVP uses separate API/Worker and reopens Bot/task/command receipts after restart',{timeout:30000},async t=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'chestnut-mvp-'));
  let child:ReturnType<typeof spawn>|undefined,output='',url='';
  async function stop(){if(!child)return;const process=child;child=undefined;if(process.exitCode!==null)return;process.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>process.once('exit',()=>resolve())),sleep(4000).then(()=>{process.kill('SIGKILL');throw new Error('Demo did not shut down cleanly');})]);}
  async function start(){output='';url='';child=spawn(process.execPath,['scripts/demo-ui.mjs','--data-dir',dir,'--port','0','--delay-ms','1200'],{stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream?.on('data',data=>{output+=data;const match=output.match(/dashboard (http:\/\/127\.0\.0\.1:\d+)/);if(match)url=match[1]!;});for(let i=0;i<100&&!url&&child.exitCode===null;i++)await sleep(50);if(!url){if(/listen EPERM|listen EACCES/.test(output)){t.skip('Executor disallows real loopback listeners; no live process claim');return false;}throw new Error('Demo startup failed: '+output);}return true;}
  async function api(path:string,body?:unknown){const response=await fetch(url+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});assert.ok(response.ok,`${response.status} ${await response.clone().text()}`);return response.json() as Promise<any>;}
  async function until(path:string,state:string){for(let i=0;i<150;i++){const value=await api(path);if(value.state===state)return value;await sleep(50);}throw new Error('Task did not reach '+state);}
  try{
    if(!await start())return;
    const creationId=randomUUID(),bot=await api('/api/bots',{name:'MVP',requestId:creationId});assert.equal((await api('/api/bots',{name:'MVP',requestId:creationId})).id,bot.id);
    const base=`/api/bots/${bot.id}`,messageId=randomUUID(),task=await api(base+'/tasks',{prompt:'first',messageId});assert.equal((await api(base+'/tasks',{prompt:'first',messageId})).id,task.id);
    await until(base+'/tasks/'+task.id,'running');
    const steerId=randomUUID();await api(base+'/tasks/'+task.id+'/commands',{type:'steer',text:'shorter',messageId:steerId});
    const follow=await api(base+'/tasks/'+task.id+'/commands',{type:'follow_up',text:'next',messageId:randomUUID()});assert.equal(follow.parentTaskId,task.id);
    const result=await until(base+'/tasks/'+task.id,'succeeded');assert.match(result.result,/Demo result: first/);await until(base+'/tasks/'+follow.id,'succeeded');
    assert.equal((await api(base+'/requests/'+messageId)).response.state,'succeeded');assert.equal((await api(base+'/requests/'+steerId)).response.state,'sent_unconfirmed');
    const cancelled=await api(base+'/tasks',{prompt:'cancel me',messageId:randomUUID()});await until(base+'/tasks/'+cancelled.id,'running');
    const nested=await api(base+'/tasks/'+cancelled.id+'/commands',{type:'follow_up',text:'must not run',messageId:randomUUID()});await api(base+'/tasks/'+cancelled.id+'/commands',{type:'cancel',messageId:randomUUID()});await until(base+'/tasks/'+cancelled.id,'cancelled');assert.equal((await api(base+'/tasks/'+nested.id)).state,'cancelled');
    const workerBefore=(await api('/api/status')).worker;assert.equal(workerBefore.online,true);assert.match(output,/Chestnut worker/);assert.match(output,/EXPLICIT DEMO/);
    await stop();assert.ok(await start());assert.equal((await api('/api/bot-requests/'+creationId)).id,bot.id);assert.equal((await api(base+'/requests/'+messageId)).response.result,result.result);assert.equal((await api(base+'/tasks/'+nested.id)).state,'cancelled');assert.equal((await api(base+'/tasks')).length,4);
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
