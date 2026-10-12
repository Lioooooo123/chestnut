import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { Store } from '../src/store.ts';
import { config,prepareStorage } from '../src/config.ts';
const root=await realpath(await mkdtemp(join(tmpdir(),'chestnut-demo-')));
const env={...process.env,CHESTNUT_MODE:'demo',CHESTNUT_DATA_DIR:root,OPENAI_API_KEY:undefined};
const c=config(env);prepareStorage(c);const store=new Store(c.dbPath);
const worker=spawn(process.execPath,['src/cli.ts','worker'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','inherit','inherit']});
const exited=once(worker,'exit');
try{
  console.log('MODEL-LESS DEMO: no AI, agent shell, provider calls, or containers. Real API and browser are not exercised.');
  const bot=store.createBot('Chestnut demo');
  const messageId=randomUUID();const task=store.submit(bot.id,messageId,'Organize this demo task');
  if(store.submit(bot.id,messageId,'Organize this demo task').id!==task.id)throw new Error('Idempotency failed');
  const follow=store.command(bot.id,task.id,randomUUID(),'follow_up','Continue with a summary');
  let steered=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const current=store.task(bot.id,task.id),next=store.task(bot.id,follow.id);
    if(current.state==='running'&&!steered){store.command(bot.id,task.id,randomUUID(),'steer','Keep it short');steered=true;console.log('Steering persisted; queued follow-up remains separate.');}
    if(next.state==='succeeded'){console.log(JSON.stringify({first:current.state,followUp:next.state,result:next.result,events:store.events(bot.id,task.id).map(e=>e.type)},null,2));break;}
    if(['failed','cancelled','interrupted'].includes(next.state))throw new Error(`Unexpected ${next.state}`);
    await sleep(100);
  }
  if(store.task(bot.id,follow.id).state!=='succeeded')throw new Error('Demo timed out');
}finally{worker.kill('SIGTERM');await exited;store.close();await rm(root,{recursive:true,force:true});}
