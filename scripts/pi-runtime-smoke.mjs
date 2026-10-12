// Offline contract smoke only. No prompt, model request or tool execution.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'chestnut-pi-smoke-'));
try {
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',join(root,'scripts/test-no-network.mjs'),join(root,'vendor/pi/packages/coding-agent/dist/bundle/rpc-entry.js'),
      '--no-tools','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','--no-session'],{
      cwd:directory,env:{PATH:process.env.PATH,HOME:directory,PI_CODING_AGENT_DIR:join(directory,'agent'),PI_OFFLINE:'1',PI_NO_UPDATE_CHECK:'1'},stdio:['pipe','pipe','pipe'],shell:false});
    let output='',errors='',received=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Built Pi RPC readiness timeout: ${errors}`));},10000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-8192);});
    child.stdout.on('data',chunk=>{
      output+=chunk;
      let index;
      while((index=output.indexOf('\n'))>=0){
        const line=output.slice(0,index);output=output.slice(index+1);
        if(!line.trim())continue;
        try{const event=JSON.parse(line);if(event.type==='response'&&event.id==='smoke-state'){
          if(event.success!==true||event.command!=='get_state')throw new Error('get_state rejected');
          if(event.data.isStreaming!==false)throw new Error('Unexpected running agent');
          received=true;child.stdin.end();
        }}catch(error){child.kill('SIGKILL');reject(error);}
      }
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code===0&&received)resolve();else reject(new Error(`Built Pi RPC smoke failed (${code}): ${errors}`));});
    child.stdin.write(JSON.stringify({id:'smoke-state',type:'get_state'})+'\n');
  });
  console.log('Built vendored Pi RPC returned get_state and shut down cleanly; no prompt/tools/network used.');
} finally { await rm(directory,{recursive:true,force:true}); }
