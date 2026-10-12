import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readdir, rm, mkdir, writeFile, symlink, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preflight, validateNewDataDirectory, type Probe } from '../src/deployment/preflight.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';

test('offline preflight never invokes host tools or creates a data directory',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'cn-preflight-'));
  try{const path=join(root,'new-data');const result=await preflight({offline:true,dataDir:path},{platform:'darwin',uid:process.getuid?.(),nodeVersion:'26.5.0',run:async()=>{throw new Error('No command may run');}});assert.equal(result.passed,true);assert.equal(result.readyForDockerAcceptance,false);assert.equal(result.operationallyVerified,false);assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
test('new-data admission rejects existing state, symlink ancestors and other-writable parents without changing files',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'cn-preflight-'));
  try{await mkdir(join(root,'state'));await writeFile(join(root,'state','keep'),'user data');const before=(await stat(join(root,'state'))).mode;await assert.rejects(validateNewDataDirectory(join(root,'state')),/already exists/);await symlink(root,join(root,'link'));await assert.rejects(validateNewDataDirectory(join(root,'link','new')),/canonical/);await mkdir(join(root,'shared'));await chmod(join(root,'shared'),0o777);await assert.rejects(validateNewDataDirectory(join(root,'shared','new')),/writable/);assert.equal((await stat(join(root,'state'))).mode,before);assert.deepEqual(await readdir(join(root,'state')),['keep']);}finally{await rm(root,{recursive:true,force:true});}
});
test('Docker probes admit only local rootless cgroup-controlled pinned images and emit no raw daemon secrets',async()=>{
  const calls:string[][]=[];const run:Probe=async(program,args)=>{calls.push([program,...args]);if(program==='flock')return 'flock from util-linux 2.40';if(args[0]==='context')return args[1]==='show'?'rootless':'"unix:///run/user/1000/docker.sock"';if(args[0]==='info')return JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:true,unrelatedSecret:'must-not-appear'});return JSON.stringify([{Id:`sha256:${'a'.repeat(64)}`,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.chestnut.pi.commit':PI_SOURCE_COMMIT}}}]);};
  const root=await mkdtemp(join(await realpath(tmpdir()),'cn-preflight-'));
  try{const report=await preflight({docker:true,dataDir:join(root,'new')},{platform:'linux',uid:process.getuid?.(),nodeVersion:'24.19.0',run});assert.equal(report.readyForDockerAcceptance,true);assert.ok(!JSON.stringify(report).includes('must-not-appear'));assert.ok(calls.every(([,arg])=>!['create','run','build','pull','start'].includes(arg)));const refused=await preflight({docker:true},{platform:'linux',uid:process.getuid?.(),nodeVersion:'24.19.0',run:async(p,a)=>p==='flock'?'util-linux':a[0]==='context'?(a[1]==='show'?'remote':'"ssh://remote-host"'):run(p,a)});assert.equal(refused.passed,false);assert.equal(refused.readyForDockerAcceptance,false);}finally{await rm(root,{recursive:true,force:true});}
});
test('Docker acceptance defaults to a plan, refuses existing runtime and never creates it on this host',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'cn-acceptance-'));
  try{const result=await promisify(execFile)(process.execPath,['scripts/acceptance-docker.mjs','--data-dir',join(root,'new')]);assert.equal(JSON.parse(result.stdout).state,'not_run');assert.deepEqual(await readdir(root),[]);await assert.rejects(promisify(execFile)(process.execPath,['scripts/acceptance-docker.mjs','--execute','--data-dir',root]));assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
