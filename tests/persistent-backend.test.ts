import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, lstat, realpath, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentDockerBackend, cleanupPersistentBot, persistentCreateArgs, verifyPersistentInspection } from '../src/sandbox/persistent-docker.ts';
import type { DockerAttachment, DockerCommandRunner, PersistentDockerOptions } from '../src/sandbox/persistent-docker.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function inspection(o:PersistentDockerOptions,running=false){return {
  Id:'container-one',Image:'sha256:pinned-image',State:{Running:running,Paused:false,Restarting:false},
  Config:{Image:o.image??`chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`,User:'0:0',Labels:{'chestnut.bot':'bot1','chestnut.profile':'persistent','chestnut.schema':'1'},Entrypoint:['node'],Cmd:['/opt/chestnut/persistent-supervisor.mjs'],Env:['PATH=/usr/local/bin:/usr/bin','HOME=/tmp/home','PI_OFFLINE=1']},
  HostConfig:{NetworkMode:'none',Privileged:false,ReadonlyRootfs:false,CapDrop:['ALL'],CapAdd:[] as string[],SecurityOpt:['no-new-privileges'],Devices:[],DeviceRequests:[],PidMode:'',IpcMode:'private',CgroupnsMode:'private',UTSMode:'',UsernsMode:'',Binds:[],ExtraHosts:[],PortBindings:{},PublishAllPorts:false,AutoRemove:false,RestartPolicy:{Name:'no'},VolumesFrom:[],Memory:1024*1024*1024,MemorySwap:1024*1024*1024,PidsLimit:128,NanoCpus:1_000_000_000,Init:true},
  Mounts:[{Type:'bind',Source:join(o.dataRoot,'bots','bot1','workspace'),Destination:'/workspace',RW:true,Propagation:'rprivate'},{Type:'bind',Source:o.gatewayDirectory,Destination:'/run/chestnut',RW:false,Propagation:'rprivate'}],
};}
class FakeDocker implements DockerCommandRunner{
  calls:string[][]=[];current:ReturnType<typeof inspection>|undefined;
  options:PersistentDockerOptions;resourceControls=true;stopFails=false;keepRunning=false;beforeReturn?: (args:string[])=>void;terminated=0;
  constructor(options:PersistentDockerOptions){this.options=options;}
  async command(args:string[]):Promise<string>{
    this.calls.push([...args]);let result='';
    if(args[0]==='info')result=JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:this.resourceControls?'systemd':'none',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:true});
    else if(args[0]==='image')result=JSON.stringify([{Id:'sha256:pinned-image',Config:{Labels:{'org.chestnut.pi.commit':PI_SOURCE_COMMIT,'org.chestnut.persistent.profile':'experimental-v1'}}}]);
    else if(args[0]==='create'){this.current=inspection(this.options);result='container-one';}
    else if(args[0]==='container'&&args[1]==='ls')result=this.current?'container-one\n':'';
    else if(args[0]==='container'&&args[1]==='inspect')result=JSON.stringify([this.current]);
    else if(args[0]==='container'&&args[1]==='start'){assert.ok(this.current);this.current.State.Running=true;result='chestnut-bot-bot1';}
    else if(args[0]==='container'&&args[1]==='stop'){
      if(this.stopFails)throw new Error('daemon stop failed');assert.ok(this.current);if(!this.keepRunning)this.current.State.Running=false;result='chestnut-bot-bot1';
    }else throw new Error(`Unexpected command: ${args.join(' ')}`);
    this.beforeReturn?.(args);return result;
  }
  attach(args:string[]):DockerAttachment{this.calls.push([...args]);return {write:async()=>{},onLine:()=>{},onClose:()=>{},terminate:async()=>{this.terminated++;}};}
}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'chestnut-persistent-'));
  const dataRoot=join(root,'sandbox'),gatewayDirectory=join(root,'gateways','bot-bot1');
  const workspace=join(dataRoot,'bots','bot1','workspace');
  await mkdir(workspace,{recursive:true});await mkdir(gatewayDirectory,{recursive:true});
  // No listener/network is created. Only this designated fixture file models a socket.
  const socketFixture=join(gatewayDirectory,'run1.sock');await writeFile(socketFixture,'unit-socket-placeholder');
  const options:PersistentDockerOptions={dataRoot,gatewayDirectory,gatewaySocketName:'run1.sock',model:'test-model',canMutate:()=>true,canStart:()=>true,fileSystem:{realpath,readdir,lstat:async(path:string)=>{const stat=await lstat(path);return {isSymbolicLink:()=>stat.isSymbolicLink(),isDirectory:()=>stat.isDirectory(),isSocket:()=>path===socketFixture||stat.isSocket()};}}};
  const input={botId:'bot1',taskId:'task1',runId:'run1',prompt:'hello',workspace,sessionPath:join(dataRoot,'sessions','task1','session.jsonl')};
  return {options,input,dispose:async()=>{await rm(root,{recursive:true,force:true});}};
}
test('persistent create uses writable root and only bot workspace/model socket directory',()=>{
  const options:PersistentDockerOptions={dataRoot:'/data',gatewayDirectory:'/gateways/bot-bot1',gatewaySocketName:'run1.sock',model:'m',canMutate:()=>true,canStart:()=>true};
  const args=persistentCreateArgs('bot1',options);
  assert.equal(args[0],'create');assert.ok(args.includes('chestnut-bot-bot1'));assert.equal(args.includes('--read-only'),false);
  assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args.includes('--rm'),false);assert.equal(args.includes('--privileged'),false);
  assert.equal(args.filter(value=>value==='--mount').length,2);assert.ok(!args.join(' ').includes('docker.sock'));assert.ok(!args.join(' ').includes('API_KEY'));
  assert.throws(()=>persistentCreateArgs('bot1',{...options,networkPolicy:'maintenance'}),/pending policy/);
});
test('create/start/exec then normal dispose stops entire bot without deleting rootfs',async()=>{
  const f=await fixture();try{
    const docker=new FakeDocker(f.options);const states:string[]=[];
    const backend=new PersistentDockerBackend({...f.options,runner:docker,onEnvironment:state=>states.push(state.state)});
    const transport=await backend.launch(f.input);assert.equal(docker.current?.State.Running,true);
    const stopA=transport.stop(),stopB=transport.stop();assert.equal(stopA,stopB);await Promise.all([stopA,stopB]);
    assert.equal(docker.current?.State.Running,false);assert.equal(docker.current?.Id,'container-one');assert.equal(docker.terminated,1);
    assert.equal(docker.calls.some(args=>args.includes('rm')),false);assert.deepEqual(states,['stopped','running','stopped']);
    const execArgs=docker.calls.find(args=>args[0]==='exec')!;assert.ok(execArgs.includes('CHESTNUT_MODEL_SOCKET=run1.sock'));
    assert.ok(!execArgs.join(' ').includes(f.input.prompt));assert.ok(!execArgs.join(' ').includes(f.input.sessionPath));
  }finally{await f.dispose();}
});
test('next task reuses stopped container identity and starts no additional container',async()=>{
  const f=await fixture();try{
    const docker=new FakeDocker(f.options);docker.current=inspection(f.options,false);
    const transport=await new PersistentDockerBackend({...f.options,runner:docker}).launch(f.input);await transport.stop();
    assert.equal(docker.calls.filter(args=>args[0]==='create').length,0);assert.equal(docker.current?.Id,'container-one');
  }finally{await f.dispose();}
});
test('saved security and image configuration are checked rather than labels alone',()=>{
  const o:PersistentDockerOptions={dataRoot:'/data',gatewayDirectory:'/gateways/bot-bot1',gatewaySocketName:'run1.sock',model:'m',canMutate:()=>true,canStart:()=>true};
  const expected=inspection(o);assert.doesNotThrow(()=>verifyPersistentInspection(expected,'bot1',o,'sha256:pinned-image'));
  const changes=[
    (c:typeof expected)=>{c.Image='sha256:other';},(c:typeof expected)=>{c.HostConfig.NetworkMode='host';},
    (c:typeof expected)=>{c.HostConfig.Privileged=true;},(c:typeof expected)=>{c.HostConfig.CapAdd=['SYS_ADMIN'];},
    (c:typeof expected)=>{c.HostConfig.SecurityOpt=['seccomp=unconfined'];},(c:typeof expected)=>{c.HostConfig.AutoRemove=true;},
    (c:typeof expected)=>{c.Mounts[0].Source='/other-bot';},(c:typeof expected)=>{c.Mounts[1].RW=true;},
    (c:typeof expected)=>{c.Config.Env.push('OPENAI_API_KEY=secret');},(c:typeof expected)=>{c.HostConfig.PidMode='host';},(c:typeof expected)=>{c.HostConfig.CgroupnsMode='host';},(c:typeof expected)=>{c.Config.Env.push('AWS_ACCESS_KEY_ID=secret');},
  ];
  for(const mutate of changes){const c=clone(expected);mutate(c);assert.throws(()=>verifyPersistentInspection(c,'bot1',o,'sha256:pinned-image'));}
});
test('stale owner cannot stop a newer run on the same persistent container',async()=>{
  const f=await fixture();try{
    let owned=true;const options={...f.options,canMutate:()=>owned};const docker=new FakeDocker(options);docker.current=inspection(options,true);
    docker.beforeReturn=args=>{if(args[0]==='container'&&args[1]==='inspect')owned=false;};
    await assert.rejects(cleanupPersistentBot({botId:'bot1'},options,docker),/owner is stale/);
    assert.equal(docker.calls.some(args=>args[1]==='stop'),false);assert.equal(docker.current.State.Running,true);
  }finally{await f.dispose();}
});
test('cleanup requires a current outer fencing guard and verified Docker stopped state',async()=>{
  const f=await fixture();try{
    const docker=new FakeDocker(f.options);docker.current=inspection(f.options,true);
    await assert.rejects(cleanupPersistentBot({botId:'bot1'},{...f.options,canMutate:undefined as unknown as ()=>boolean},docker),/owner is stale/);
    docker.keepRunning=true;await assert.rejects(cleanupPersistentBot({botId:'bot1'},f.options,docker),/retain quarantine/);
    docker.keepRunning=false;docker.stopFails=true;await assert.rejects(cleanupPersistentBot({botId:'bot1'},f.options,docker),/daemon stop failed/);
    docker.stopFails=false;await cleanupPersistentBot({botId:'bot1'},f.options,docker);assert.equal(docker.current.State.Running,false);
  }finally{await f.dispose();}
});
test('persistent mount rejects files that could expose host credentials',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.options.gatewayDirectory,'credentials.json'),'do-not-mount');const docker=new FakeDocker(f.options);
    await assert.rejects(new PersistentDockerBackend({...f.options,runner:docker}).launch(f.input),/only per-run model sockets/);
    assert.equal(docker.calls.some(args=>args[0]==='create'),false);
  }finally{await f.dispose();}
});

test('recorded container identity forbids silent replacement or missing-rootfs recovery',async()=>{
  const f=await fixture();try{
    const options={...f.options,expectedContainerId:'original-container',expectedImageId:'sha256:pinned-image'};
    const docker=new FakeDocker(options);docker.current=inspection(options,false);
    await assert.rejects(cleanupPersistentBot({botId:'bot1'},options,docker),/identity changed/);
    assert.equal(docker.calls.some(args=>args[1]==='stop'),false);
    docker.current=undefined;
    await assert.rejects(new PersistentDockerBackend({...options,runner:docker}).launch(f.input),/missing/);
    assert.equal(docker.calls.some(args=>args[0]==='create'),false);
    await assert.rejects(cleanupPersistentBot({botId:'bot1'},options,docker),/missing/);
  }finally{await f.dispose();}
});

test('native filesystem validation rejects the mock regular file as a real socket',async()=>{
  const f=await fixture();try{
    const docker=new FakeDocker(f.options);
    await assert.rejects(new PersistentDockerBackend({...f.options,fileSystem:undefined,runner:docker}).launch(f.input),/only per-run model sockets/);
    assert.equal(docker.calls.some(args=>args[0]==='create'),false);
  }finally{await f.dispose();}
});
test('persistent gateway path rejects symlink indirection before any container is created',async()=>{
  const f=await fixture();try{
    const alias=join(f.options.gatewayDirectory,'..','alias');await symlink(f.options.gatewayDirectory,alias);
    const docker=new FakeDocker(f.options);
    await assert.rejects(new PersistentDockerBackend({...f.options,gatewayDirectory:alias,runner:docker}).launch(f.input),/symlinks/);
    assert.equal(docker.calls.some(args=>args[0]==='create'),false);
  }finally{await f.dispose();}
});

test('accepted cancellation denies create/start/exec while retaining cleanup authority',async()=>{
  const f=await fixture();try{
    const options={...f.options,canStart:()=>false};const docker=new FakeDocker(options);
    await assert.rejects(new PersistentDockerBackend({...options,runner:docker}).launch(f.input),/admission closed/);
    assert.equal(docker.calls.some(args=>args[0]==='create'||args[0]==='exec'||args[1]==='start'),false);
  }finally{await f.dispose();}
});
test('cancellation after create prevents start and leaves the writable rootfs stopped',async()=>{
  const f=await fixture();try{
    let admitted=true;const options={...f.options,canStart:()=>admitted};const docker=new FakeDocker(options);
    docker.beforeReturn=args=>{if(args[0]==='create')admitted=false;};
    await assert.rejects(new PersistentDockerBackend({...options,runner:docker}).launch(f.input),/admission closed/);
    assert.equal(docker.calls.some(args=>args[0]==='exec'||args[1]==='start'),false);
    assert.equal(docker.current?.State.Running,false);assert.equal(docker.current?.Id,'container-one');
  }finally{await f.dispose();}
});

test('unsupported cgroups block launch while trusted cleanup remains available',async()=>{
  const f=await fixture();try{
    const docker=new FakeDocker(f.options);docker.resourceControls=false;
    await assert.rejects(new PersistentDockerBackend({...f.options,runner:docker}).launch(f.input),/cgroup v2/);
    assert.equal(docker.calls.some(args=>args[0]==='create'||args[1]==='start'),false);
    docker.current=inspection(f.options,true);
    await cleanupPersistentBot({botId:'bot1'},f.options,docker);
    assert.equal(docker.current.State.Running,false);
  }finally{await f.dispose();}
});
