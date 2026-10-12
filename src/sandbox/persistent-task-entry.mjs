// Runs inside the experimental writable-root bot. No provider secret enters it.
// Root can alter this file; host Docker state, never this script, certifies stop.
import { createServer, request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const model=process.env.CHESTNUT_MODEL;
const socket=process.env.CHESTNUT_MODEL_SOCKET;
const task=process.env.CHESTNUT_TASK_ID;
const run=process.env.CHESTNUT_RUN_ID;
const id=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
if(!model||!task||!run||!id.test(task)||!id.test(run)||socket!==`${run}.sock`)throw new Error('Invalid persistent task configuration');
const relay=createServer((incoming,outgoing)=>{
  if(incoming.method!=='POST'||incoming.url!=='/v1/chat/completions'){outgoing.writeHead(403);outgoing.end('Route not allowed');return;}
  const upstream=request({socketPath:`/run/chestnut/${socket}`,path:incoming.url,method:'POST',headers:{'content-type':'application/json'}},response=>{
    outgoing.writeHead(response.statusCode??502,{'content-type':response.headers['content-type']??'application/json','cache-control':'no-store'});response.pipe(outgoing);
  });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end('Model gateway unavailable');});
  incoming.on('aborted',()=>upstream.destroy());outgoing.on('close',()=>upstream.destroy());incoming.pipe(upstream);
});
await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(4011,'127.0.0.1',resolve);});
const agentDir=`/tmp/chestnut-agent-${run}`;
const sessionDir=`/var/lib/chestnut/sessions/${task}`;
await mkdir(agentDir,{recursive:true,mode:0o700});await mkdir(sessionDir,{recursive:true,mode:0o700});await mkdir('/root',{recursive:true,mode:0o700});
await writeFile(`${agentDir}/models.json`,JSON.stringify({providers:{chestnut:{baseUrl:'http://127.0.0.1:4011/v1',api:'openai-completions',apiKey:'chestnut-local-no-secret',models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false,supportsStore:false}}]}}}),{mode:0o600});
const child=spawn('node',['/opt/pi/packages/coding-agent/dist/bundle/rpc-entry.js','--provider','chestnut','--model',model,
  '--session',`${sessionDir}/session.jsonl`,'--session-dir',sessionDir,
  '--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve'],{
    stdio:'inherit',shell:false,env:{...process.env,HOME:'/root',PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',PI_NO_UPDATE_CHECK:'1'}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{relay.close();process.exitCode=1;});child.on('exit',code=>{relay.close();process.exitCode=code??1;});
