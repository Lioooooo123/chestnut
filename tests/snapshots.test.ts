import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,rm,writeFile,readFile,symlink,link,lstat,chmod,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { StableEnvironment,stableName,ENVIRONMENT_CAPABILITIES } from '../src/environments/stable-docker.ts';
import { BotSnapshots,workspaceInventory,verifyDockerArchive } from '../src/environments/snapshots.ts';
import { EnvironmentOperations,type EnvironmentOperation } from '../src/environments/operations.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';
import { Scheduler } from '../src/schedules.ts';
import { Worker } from '../src/worker.ts';
import { config } from '../src/config.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DockerCommandRunner } from '../src/sandbox/persistent-docker.ts';

function archive(name='manifest.json',type='0',text='[]'){
  const h=Buffer.alloc(512);h.write(name,0,100);h.write('0000600\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(Buffer.byteLength(text).toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);let sum=0;for(const b of h)sum+=b;h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);const payload=Buffer.alloc(Math.ceil(Buffer.byteLength(text)/512)*512);payload.write(text);return Buffer.concat([h,payload,Buffer.alloc(1024)]);
}
const sha=()=>`sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`;
/** Docker is synthetic; workspace/archive files, checksum and SQLite are real. */
class FixtureDocker implements DockerCommandRunner {
  containers=new Map<string,any>();images=new Map<string,any>();calls:string[][]=[];afterRenameFailure=false;
  async command(args:string[]):Promise<string>{this.calls.push(args);const find=(key:string)=>this.containers.get(key)||[...this.containers.values()].find(c=>c.Id===key);
    if(args[0]==='info')return JSON.stringify({SecurityOptions:['name=rootless'],CgroupVersion:'2',CgroupDriver:'systemd',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:true});
    if(args[0]==='image'&&args[1]==='inspect'){const image=this.images.get(args[2]!);if(!image)throw new Error('Missing image');return JSON.stringify([image]);}
    if(args[0]==='image'&&args[1]==='save'){await writeFile(args[3]!,archive());return '';}
    if(args[0]==='image'&&args[1]==='load')return 'Fixture load, not Docker';
    if(args[0]==='container'&&args[1]==='ls'){const name=args[args.indexOf('--filter')+1]!.slice('name=^/'.length,-1);return this.containers.get(name)?.Id??'';}
    if(args[0]==='container'&&args[1]==='inspect'){const c=find(args.at(-1)!);if(!c)throw new Error('Missing container');return JSON.stringify([{...c,SizeRootFs:1024}]);}
    if(args[0]==='container'&&args[1]==='stop'){find(args.at(-1)!).State.Running=false;return '';}
    if(args[0]==='container'&&args[1]==='start'){find(args.at(-1)!).State.Running=true;return '';}
    if(args[0]==='container'&&args[1]==='commit'){const imageId=sha(),labels:any={'org.chestnut.pi.commit':PI_SOURCE_COMMIT};for(let i=0;i<args.length;i++)if(args[i]==='--change'){const [key,value]=args[i+1]!.slice(6).split('=');labels[key!]=value;}this.images.set(imageId,{Id:imageId,Size:1024,Config:{Labels:labels}});return imageId;}
    if(args[0]==='container'&&args[1]==='rename'){const c=find(args[2]!);if(this.containers.has(args[3]!))throw new Error('Name already present');for(const [name,value]of this.containers)if(value.Id===c.Id)this.containers.delete(name);c.Name=args[3];this.containers.set(args[3]!,c);if(this.afterRenameFailure){this.afterRenameFailure=false;throw new Error('Reply lost after rename');}return '';}
    if(args[0]==='create'){const name=args[args.indexOf('--name')+1]!,image=args[args.indexOf('--entrypoint')+2]!,mount=args[args.indexOf('--mount')+1]!,bot=args.find(a=>a.startsWith('chestnut.bot='))!.slice(13);const c={Id:randomUUID(),Name:name,Image:this.images.get(image).Id,State:{Running:false},Config:{Image:image,User:'0:0',Labels:{'chestnut.bot':bot,'chestnut.profile':'service-v1','chestnut.schema':'1'},Entrypoint:['node'],Cmd:['-e','setInterval(() => {}, 60000)'],Env:['HOME=/tmp/home']},HostConfig:{NetworkMode:'none',Privileged:false,ReadonlyRootfs:false,Init:true,CapDrop:['ALL'],CapAdd:[...ENVIRONMENT_CAPABILITIES],SecurityOpt:['no-new-privileges'],IpcMode:'private',CgroupnsMode:'private',Memory:1073741824,MemorySwap:1073741824,PidsLimit:128,NanoCpus:1000000000},Mounts:[{Type:'bind',Source:mount.split('source=')[1]!.split(',target=')[0],Destination:'/workspace',RW:true,Propagation:'rprivate'}]};this.containers.set(name,c);return c.Id;}
    throw new Error('Unexpected fixture command '+args.join(' '));
  }
  attach():never{throw new Error('No attachments in snapshot fixture');}
}
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'cn-snapshot-')),s=new Store(join(root,'control.sqlite')),bot=s.createBot('Snapshot'),ops=new EnvironmentOperations(s),docker=new FixtureDocker(),image=sha();docker.images.set(image,{Id:image,Size:1024,Config:{Labels:{'org.chestnut.pi.commit':PI_SOURCE_COMMIT}}});const workspace=join(root,'sandbox','bots',bot.id,'workspace');await mkdir(workspace,{recursive:true,mode:0o700});await writeFile(join(workspace,'file.txt'),'first');s.ensureEnvironment(bot.id,'service');let held=true;const env=new StableEnvironment(bot.id,{dataRoot:join(root,'sandbox'),image,canMutate:()=>held,canExecute:()=>held,onEnvironment:state=>s.observeEnvironment(bot.id,state)},docker);await env.ensureRunning();const snapshots=new BotSnapshots(s,root,env);const running=(action:string,payload:Record<string,unknown>={})=>{const o=ops.request(bot.id,randomUUID(),action,payload);s.db.prepare("UPDATE environment_operations SET state='running' WHERE requestId=?").run(o.requestId);return o;};return {root,s,bot,ops,docker,env,snapshots,workspace,running,revoke:()=>{held=false;},async close(){s.close();await rm(root,{recursive:true,force:true});}};}

test('stopped snapshots verify real files/checksums, restore creates protection and cold identity, old data retained',async()=>{const f=await fixture();try{const o=f.running('snapshot'),snapshot=await f.snapshots.create(o);f.ops.finish(o,snapshot);await writeFile(join(f.workspace,'file.txt'),'second');const original=f.s.environment(f.bot.id)!.containerId;const restore=f.running('restore',{snapshotId:snapshot.id}),result=await f.snapshots.restore(restore,snapshot.id);f.ops.finish(restore,result);assert.equal(await readFile(join(f.workspace,'file.txt'),'utf8'),'first');assert.equal(await readFile(join(result.backupWorkspace,'file.txt'),'utf8'),'second');assert.notEqual(f.s.environment(f.bot.id)!.containerId,original);assert.equal(f.s.environment(f.bot.id)!.state,'stopped');assert.equal(f.snapshots.list().length,2);assert.equal((await f.snapshots.load(result.protectionId)).manifest.botId,f.bot.id);const current=f.s.environment(f.bot.id)!;const fresh=new StableEnvironment(f.bot.id,{...f.env.options,image:current.imageRef!,expectedContainerId:current.containerId,expectedImageId:current.imageId},f.docker);await fresh.ensureRunning();assert.equal(f.docker.containers.get(stableName(f.bot.id)).State.Running,true);}finally{await f.close();}});

for(const phase of ['protection-published','loading-image','candidate-verified','swapping-workspace','workspace-moved-aside','renaming-old-container','renaming-candidate','identity-switch','after-identity'])test(`restore failure/death at ${phase} blocks work and explicit rollback restores protection`,async()=>{const f=await fixture();try{const o=f.running('snapshot'),snapshot=await f.snapshots.create(o);f.ops.finish(o,snapshot);await writeFile(join(f.workspace,'file.txt'),'current');const operation=f.running('restore',{snapshotId:snapshot.id}),original=f.ops.phase.bind(f.ops);f.snapshots.operations.phase=(job,stage,result)=>{original(job,stage,result);if(stage===phase)throw new Error('Injected death');};if(phase==='after-identity')await f.snapshots.restore(operation,snapshot.id);else await assert.rejects(f.snapshots.restore(operation,snapshot.id),/Injected death/);f.ops.uncertain(operation);assert.equal(f.ops.get(f.bot.id,operation.requestId).state,'uncertain');assert.throws(()=>f.s.submit(f.bot.id,randomUUID(),'must wait'),/pending/);assert.equal(f.s.claim('other'),null);const blocked=f.ops.get(f.bot.id,operation.requestId),recovery=f.running('rollback',{operationId:operation.requestId});const result=await f.snapshots.rollback(recovery,blocked);f.ops.finish(recovery,result);assert.equal(await readFile(join(f.workspace,'file.txt'),'utf8'),'current');assert.equal(f.s.environment(f.bot.id)!.state,'stopped');assert.ok(f.s.submit(f.bot.id,randomUUID(),'new explicit work'));}finally{await f.close();}});

test('snapshot request rejects active writers, scopes IDs, deduplicates and pauses scheduler admission',async()=>{const f=await fixture();try{const task=f.s.submit(f.bot.id,randomUUID(),'active'),run=f.s.claim('fixture')!;assert.throws(()=>f.ops.request(f.bot.id,randomUUID(),'snapshot'),/active/);f.s.finish(run,'succeeded','done',null);const scheduled=new Scheduler(f.s);scheduled.create(f.bot.id,{requestId:randomUUID(),name:'Later',prompt:'wait',kind:'once',runAt:Date.now()+1000});const id=randomUUID(),o=f.ops.request(f.bot.id,id,'snapshot');assert.equal(f.ops.request(f.bot.id,id,'snapshot').requestId,o.requestId);assert.throws(()=>f.ops.request(f.bot.id,id,'desktop'),/different/);assert.equal(scheduled.tick(Date.now()+2000).length,0);const other=f.s.createBot('Other');assert.throws(()=>f.ops.get(other.id,id),/not found/);assert.throws(()=>f.ops.request(other.id,randomUUID(),'restore',{snapshotId:randomUUID()}),/not found/);assert.equal(f.s.task(f.bot.id,task.id).state,'succeeded');}finally{await f.close();}});

test('links, traversal, device archive records, checksum mutation and closed lock grants fail closed',async()=>{const f=await fixture();try{await symlink('/outside',join(f.workspace,'link'));await assert.rejects(workspaceInventory(f.workspace),/links/);await rm(join(f.workspace,'link'));await link(join(f.workspace,'file.txt'),join(f.workspace,'hard'));await assert.rejects(workspaceInventory(f.workspace),/links/);await rm(join(f.workspace,'hard'));const archivePath=join(f.root,'bad.tar');for(const [name,type]of [['../escape','0'],['/absolute','0'],['link','2'],['device','3'],['extension','x']]){await writeFile(archivePath,archive(name,type));await assert.rejects(verifyDockerArchive(archivePath),/Unsafe/);}const o=f.running('snapshot'),snapshot=await f.snapshots.create(o);f.ops.finish(o,snapshot);await writeFile(join(f.root,'control','snapshots',f.bot.id,snapshot.id,'rootfs.tar'),'tamper');await assert.rejects(f.snapshots.load(snapshot.id),/checksum/);f.revoke();await assert.rejects(f.snapshots.create(f.running('snapshot')),/closed/);}finally{await f.close();}});

for(const crashed of [false,true])test(crashed?'new Worker marks a dead running operation uncertain without replay':'actual Worker queue completes a model-less snapshot operation with verified lock release',{timeout:20000},async()=>{
  const f=await fixture();const operation=f.ops.request(f.bot.id,randomUUID(),'snapshot');
  if(crashed){f.s.db.prepare("UPDATE environment_operations SET state='running',phase='snapshot-archive',ownerId='dead-owner' WHERE requestId=?").run(operation.requestId);f.s.heartbeat('dead-owner',Date.now()-30000,1);}
  const c=config({CHESTNUT_MODE:'pi',CHESTNUT_SANDBOX_PROFILE:'service',CHESTNUT_EXPERIMENTAL_SERVICE:'1',CHESTNUT_DATA_DIR:f.root,CHESTNUT_IMAGE:f.env.options.image,CHESTNUT_MEMORY_AUTOMATIC:'0'});c.gatewayRoot=join(f.root,'gateway');
  let releases=0;const worker=new Worker(f.s,c,undefined,{acquireLock:async()=>{let held=true;return {runner:f.docker,isHeld:()=>held,release:async()=>{held=false;releases++;}};}}),before=f.docker.calls.length,work=worker.run();
  try{let outcome='';for(let i=0;i<300;i++){outcome=f.ops.get(f.bot.id,operation.requestId).state;if(['succeeded','uncertain'].includes(outcome))break;await sleep(25);}assert.equal(outcome,crashed?'uncertain':'succeeded');assert.ok(releases>0);if(crashed){assert.equal(f.docker.calls.length,before);assert.equal(f.snapshots.list().length,0);}else assert.equal(f.snapshots.list().length,1);}finally{await worker.stop();await work;await f.close();}
});

for(const mode of [0o775,0o555])test(`snapshot/load/restore preserve nested directory mode ${mode.toString(8)} under umask 022`,async()=>{
  const previousMask=process.umask(0o022),f=await fixture();
  async function writableTree(path:string){await chmod(path,0o700);for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory())await writableTree(join(path,entry.name));}
  try{
    const parent=join(f.workspace,'nested'),child=join(parent,'child');await mkdir(child,{recursive:true,mode:0o700});await writeFile(join(child,'sample.txt'),'snapshot content');await chmod(child,mode);await chmod(parent,mode);
    const expected=await workspaceInventory(f.workspace),o=f.running('snapshot'),snapshot=await f.snapshots.create(o);f.ops.finish(o,snapshot);
    assert.deepEqual((await f.snapshots.load(snapshot.id)).manifest.workspace,expected);
    const saved=join(f.root,'control','snapshots',f.bot.id,snapshot.id,'workspace');for(const relative of ['nested','nested/child'])assert.equal((await lstat(join(saved,relative))).mode&0o777,mode);
    await writeFile(join(child,'sample.txt'),'changed');const restore=f.running('restore',{snapshotId:snapshot.id}),result=await f.snapshots.restore(restore,snapshot.id);f.ops.finish(restore,result);
    assert.deepEqual(await workspaceInventory(f.workspace),expected);assert.equal(await readFile(join(f.workspace,'nested','child','sample.txt'),'utf8'),'snapshot content');
    for(const relative of ['nested','nested/child'])assert.equal((await lstat(join(f.workspace,relative))).mode&0o777,mode);
    assert.equal((await f.snapshots.load(result.protectionId)).manifest.workspace.files.find(entry=>entry.path==='nested/child')!.mode,mode);
  }finally{process.umask(previousMask);await writableTree(f.root);await f.close();}
});
