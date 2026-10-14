import test from 'node:test';
import assert from 'node:assert/strict';
import { macPreflight } from '../src/deployment/mac-preflight.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';
import type { Probe } from '../src/deployment/preflight.ts';
const host={platform:'darwin',uid:501,nodeVersion:'26.5.0'};
test('stopped or missing existing VM never causes SSH, start, install or context mutation',async()=>{
  for(const rows of [[],[{name:'default',status:'Stopped',arch:'aarch64',secret:'never echo'}]]){const calls:string[][]=[];const run:Probe=async(p,a)=>{calls.push([p,...a]);return JSON.stringify(rows);};const report=await macPreflight({}, {...host,run});assert.equal(report.passed,false);assert.equal(report.readyForGuestAcceptance,false);assert.deepEqual(calls,[['colima','list','--json']]);assert.ok(!JSON.stringify(report).includes('never echo'));}
});
test('existing Linux guest requires real flock and rootless resources/pinned ARM64 image; probes are read only',async()=>{
  const calls:string[][]=[];const run:Probe=async(p,a)=>{calls.push([p,...a]);if(a[0]==='list')return JSON.stringify({name:'default',status:'Running',arch:'aarch64'});assert.deepEqual(a.slice(0,4),['--profile','default','ssh','--']);const command=a.slice(4),[program,...args]=command[0]==='env'?command.slice(5):command;if(program==='uname')return 'Linux';if(program==='id')return '1000';if(program==='node')return '24.19.0';if(program==='flock')return 'flock from util-linux 2.40';assert.equal(program,'docker');if(args[0]==='context')return args[1]==='show'?'rootless':'"unix:///run/user/1000/docker.sock"';if(args[0]==='info')return JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:true,unrelatedSecret:'never echo'});return JSON.stringify([{Id:`sha256:${'a'.repeat(64)}`,Os:'linux',Architecture:'arm64',Config:{Labels:{'org.chestnut.pi.commit':PI_SOURCE_COMMIT}}}]);};
  const report=await macPreflight({}, {...host,run});assert.equal(report.readyForGuestAcceptance,true);assert.equal(report.operationallyVerified,false);assert.ok(!JSON.stringify(report).includes('never echo'));assert.ok(calls.every(call=>!call.some(arg=>['start','create','run','build','pull','sudo'].includes(arg))));assert.equal(report.checks.find(c=>c.name==='guest-storage-and-sockets')!.state,'not_run');
  const refused=await macPreflight({}, {...host,run:async(p,a)=>a.includes('docker')&&a.includes('info')?JSON.stringify({SecurityOptions:[],CgroupVersion:'2',CgroupDriver:'cgroupfs'}):run(p,a)});assert.equal(refused.readyForGuestAcceptance,false);
});
test('invalid profile/non-Mac host and unavailable guest tools fail closed without any raw stderr',async()=>{
  let count=0;await assert.rejects(macPreflight({profile:'../new'},{...host,run:async()=>{count++;return '';}}),/Invalid/);assert.equal(count,0);
  assert.equal((await macPreflight({}, {...host,platform:'linux',run:async()=>{throw new Error('not called');}})).passed,false);
  const report=await macPreflight({}, {...host,run:async(p,a)=>{if(a[0]==='list')return JSON.stringify([{name:'default',status:'Running'}]);throw new Error('secret raw stderr');}});assert.equal(report.passed,false);assert.ok(!JSON.stringify(report).includes('secret raw stderr'));
});
