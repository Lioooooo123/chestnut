import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {verifyGatewaySockets} from '../src/sandbox/rootless-docker.ts';
test('ephemeral mount accepts actual model and memory sockets and rejects any extra file',async()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'cn-sockets-'));
 const servers=[createServer(),createServer()];
 try{for(let i=0;i<servers.length;i++)await new Promise<void>((resolve,reject)=>{servers[i]!.once('error',reject);servers[i]!.listen(join(dir,i===0?'model.sock':'memory.sock'),resolve);});
  await verifyGatewaySockets(dir,'model.sock','memory.sock');writeFileSync(join(dir,'credentials.json'),'never mount');await assert.rejects(verifyGatewaySockets(dir,'model.sock','memory.sock'),/only/);
 }finally{await Promise.all(servers.map(s=>new Promise<void>(r=>s.close(()=>r()))));rmSync(dir,{recursive:true,force:true});}
});
