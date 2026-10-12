import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRootless, assertResourceControls, buildDockerArgs } from '../src/sandbox/rootless-docker.ts';
const input={botId:'bot1',taskId:'task1',runId:'run1',prompt:'untrusted',workspace:'/data/bots/bot1/workspace',sessionPath:'/data/sessions/task1/session.jsonl'};
const options={dataRoot:'/data',gatewayDirectory:'/gateway/bot1',model:'model-id'};
test('requires actual Docker rootless security option',()=>{
  assert.throws(()=>assertRootless({SecurityOptions:['name=seccomp','name=apparmor']}),/rootless/);
  assert.throws(()=>assertRootless({SecurityOptions:['name=notrootless']}),/rootless/);
  assert.doesNotThrow(()=>assertRootless({SecurityOptions:['name=seccomp','name=rootless']}));
});
test('sandbox policy disables external network, privileges, and host secret mounts',()=>{
  const args=buildDockerArgs(input,options);
  const value=(key:string)=>args[args.indexOf(key)+1];
  assert.equal(value('--network'),'none'); assert.equal(value('--cap-drop'),'ALL');
  assert.equal(value('--security-opt'),'no-new-privileges'); assert.ok(args.includes('--read-only'));
  assert.equal(value('--pids-limit'),'128'); assert.equal(args.includes('--privileged'),false);
  const mounts=args.flatMap((arg,i)=>arg==='--mount'?[args[i+1]]:[]);
  assert.equal(mounts.length,3); assert.ok(mounts[2].endsWith('readonly'));
  assert.ok(!args.join(' ').includes('docker.sock')); assert.ok(!args.join(' ').includes('API_KEY'));
  assert.ok(!args.includes(input.prompt));
});
test('command and mount injection rejected',()=>{
  assert.throws(()=>buildDockerArgs({...input,runId:'a;id'},options),/identifier/);
  assert.throws(()=>buildDockerArgs({...input,workspace:'/data/x,target=/'},options),/mount path/);
  assert.throws(()=>buildDockerArgs(input,{...options,image:'--privileged'}),/image/);
  assert.throws(()=>buildDockerArgs(input,{...options,cpus:NaN}),/resource/);
});

test('resource-control admission requires systemd cgroup v2 and every enforced quota',()=>{
  const info={CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:true};
  assert.doesNotThrow(()=>assertResourceControls(info));
  assert.throws(()=>assertResourceControls({...info,CgroupDriver:'none'}),/cgroup v2/);
  assert.throws(()=>assertResourceControls({...info,CgroupVersion:'1'}),/cgroup v2/);
  for(const key of ['MemoryLimit','SwapLimit','PidsLimit','CpuCfsQuota'])assert.throws(()=>assertResourceControls({...info,[key]:false}),/quota controls/);
});
