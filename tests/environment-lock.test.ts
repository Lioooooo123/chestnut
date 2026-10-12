import { test as nodeTest, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,symlink,writeFile,readFile,chmod,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireEnvironmentLock,acquireEnvironmentLockForTests } from '../src/control/environment-lock.ts';

// Production uses util-linux flock and /proc/self/fd; macOS cannot validate that backend.
const test = (name:string, body:(context:TestContext)=>Promise<void>) => nodeTest(name, {
  skip: process.platform === 'linux' ? false : 'Requires Linux util-linux flock and /proc; real OS-lock behavior is unverified on this host.',
}, body);

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>,message:string,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(20);}throw new Error(message);}
async function exists(path:string){try{await access(path);return true;}catch{return false;}}
async function acquireReleased(directory:string,bot:string,executable:string){const end=Date.now()+5000;while(Date.now()<end){const lock=await acquireEnvironmentLockForTests(directory,bot,executable);if(lock)return lock;await delay(20);}throw new Error('OS lock was not released after client completion');}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function fixture(directory:string){
  const path=join(directory,'fake-docker.mjs');
  await writeFile(path,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
const [mode,...args]=process.argv.slice(2);
if(mode==='echo'){process.stdout.write(args.join(' '));}
else if(mode==='delayed'){writeFileSync(args[0],String(process.pid));setTimeout(()=>{writeFileSync(args[1],'complete');process.stdout.write('complete');},Number(args[2]));}
else if(mode==='hang'){writeFileSync(args[0],String(process.pid));setInterval(()=>{},10000);}
else if(mode==='fail'){process.stderr.write('unverified daemon transport');process.exitCode=1;}
else if(mode==='overflow'){process.stdout.write('x'.repeat(3*1024*1024));}
else if(mode==='attach'){writeFileSync(args[0],String(process.pid));process.stdout.write('ready\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',line=>process.stdout.write(line));setInterval(()=>{},10000);}
else {process.exitCode=2;}
`);await chmod(path,0o700);return path;
}
async function owner(directory:string,bot:string,executable:string,operation:string){
  const module=pathToFileURL(join(process.cwd(),'src/control/environment-lock.ts')).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import { acquireEnvironmentLockForTests } from ${JSON.stringify(module)};const lock=await acquireEnvironmentLockForTests(${JSON.stringify(directory)},${JSON.stringify(bot)},${JSON.stringify(executable)});if(!lock)throw new Error('contended');${operation}`],{stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const closed=new Promise<void>(resolve=>child.on('close',()=>resolve()));
  child.on('error',error=>{errors+=error.message;});
  return {child,closed,errors:()=>errors};
}
async function manualCleanup(directory:string,bot:string){
  const marker=join(directory,`${bot}.quarantine.json`);
  if(await exists(marker)){
    const record=JSON.parse(await readFile(marker,'utf8'));
    if(typeof record.pid==='number'&&alive(record.pid))process.kill(record.pid,'SIGKILL');
    await delay(80);await rm(marker,{force:true});
  }
}

test('OS environment mutex prevents concurrent owners until actual release',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
  try{const first=await acquireEnvironmentLock(dir,bot);assert.ok(first);assert.ok(first.isHeld());assert.equal(await acquireEnvironmentLock(dir,bot),null);await first.release();assert.equal(first.isHeld(),false);const second=await acquireEnvironmentLock(dir,bot);assert.ok(second);await second.release();await second.release();}
  finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('rapid contending flock exits are observed while descriptor closes are pending',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
  try{
    const first=await acquireEnvironmentLock(dir,bot);assert.ok(first);
    try{
      for(let batch=0;batch<4;batch++){
        const contenders=await Promise.all(Array.from({length:32},()=>acquireEnvironmentLock(dir,bot)));
        assert.ok(contenders.every(result=>result===null));
      }
    }finally{await first.release();}
  }finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('holder runner transports bounded Docker commands and attached lines, then reaps attachment',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
  try{
    const executable=await fixture(dir),lock=await acquireEnvironmentLockForTests(dir,bot,executable);assert.ok(lock);
    assert.equal(await lock.runner.command(['echo','literal','; no shell']),'literal ; no shell');
    const pidPath=join(dir,'attach.pid'),attachment=lock.runner.attach(['attach',pidPath]);
    const lines:string[]=[];attachment.onLine(line=>lines.push(line));
    await until(async()=>lines.includes('ready'),'attachment did not start');
    await attachment.write('hello\n');await until(async()=>lines.includes('hello'),'attachment write lost');
    const pid=Number(await readFile(pidPath,'utf8'));
    let closures=0;attachment.onClose(()=>closures++);await attachment.terminate();await attachment.terminate();
    assert.equal(closures,1);assert.equal(alive(pid),false);assert.equal(await lock.runner.command(['echo','after reap']),'after reap');
    await lock.release();await assert.rejects(lock.runner.command(['echo','stale']),/not held/);
  }finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('dead parent cannot release flock before delayed lifecycle command completes and is reaped',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();let worker:Awaited<ReturnType<typeof owner>>|undefined;
  try{
    const executable=await fixture(dir),started=join(dir,'started'),completed=join(dir,'completed');
    worker=await owner(dir,bot,executable,`await lock.runner.command(${JSON.stringify(['delayed',started,completed,'700'])},5000);`);
    await until(()=>exists(started),`lifecycle client never started: ${worker.errors()}`);worker.child.kill('SIGKILL');await worker.closed;
    assert.equal(await exists(completed),false);assert.equal(await acquireEnvironmentLockForTests(dir,bot,executable),null);
    await until(()=>exists(completed),'in-flight lifecycle command was incorrectly killed with its owner');
    await until(async()=>!(await exists(join(dir,`${bot}.quarantine.json`))),'holder released no ownership marker after client completion');
    const next=await acquireReleased(dir,bot,executable);await next.release();
  }finally{worker?.child.kill('SIGKILL');await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('dead parent causes attached exec client to be killed and reaped before unlock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();let worker:Awaited<ReturnType<typeof owner>>|undefined;
  try{
    const executable=await fixture(dir),pidPath=join(dir,'attached.pid');
    worker=await owner(dir,bot,executable,`lock.runner.attach(${JSON.stringify(['attach',pidPath])}).onLine(()=>{});`);
    await until(()=>exists(pidPath),'attachment did not start');const pid=Number(await readFile(pidPath,'utf8'));
    worker.child.kill('SIGKILL');await worker.closed;
    await until(async()=>!(await exists(join(dir,`${bot}.quarantine.json`))),'holder did not drain attachments');assert.equal(alive(pid),false);
    const next=await acquireReleased(dir,bot,executable);await next.release();
  }finally{worker?.child.kill('SIGKILL');await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('release drains an already issued lifecycle command rather than cancelling it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
  try{
    const executable=await fixture(dir),lock=await acquireEnvironmentLockForTests(dir,bot,executable);assert.ok(lock);
    const completed=join(dir,'completed'),command=lock.runner.command(['delayed',join(dir,'started'),completed,'200']);
    await lock.release();assert.equal(await command,'complete');assert.equal(await exists(completed),true);
  }finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('timeout poisons and retains flock, reports prompt release failure, and requires explicit manual reconciliation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
  try{
    const executable=await fixture(dir),lock=await acquireEnvironmentLockForTests(dir,bot,executable);assert.ok(lock);
    const pidPath=join(dir,'hang.pid');await assert.rejects(lock.runner.command(['hang',pidPath],100),/timed out.*unverified/);
    assert.equal(lock.isHeld(),false);const started=Date.now();await assert.rejects(lock.release(),/Operator.*reconcil/);assert.ok(Date.now()-started<1000);
    assert.equal(await acquireEnvironmentLockForTests(dir,bot,executable),null);
    const marker=join(dir,`${bot}.quarantine.json`),record=JSON.parse(await readFile(marker,'utf8'));assert.equal(record.state,'quarantined');assert.ok(alive(record.pid));
    await until(async()=>!alive(Number(await readFile(pidPath,'utf8'))),'timed out Docker client was not reaped');
    // An operator killing the holder does not, by itself, authorize a new owner.
    process.kill(record.pid,'SIGKILL');await delay(80);
    await assert.rejects(acquireEnvironmentLockForTests(dir,bot,executable),/quarantined.*ownership marker/);
    await rm(marker);const next=await acquireReleased(dir,bot,executable);await next.release();
  }finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('unexpected holder death leaves durable quarantine even while an orphan lifecycle command can finish',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();let clientPid:number|undefined;
  try{
    const executable=await fixture(dir),lock=await acquireEnvironmentLockForTests(dir,bot,executable);assert.ok(lock);
    const started=join(dir,'started'),completed=join(dir,'completed');
    const command=lock.runner.command(['delayed',started,completed,'350']);const rejected=assert.rejects(command,/helper exited/);
    await until(()=>exists(started),'lifecycle client never started');clientPid=Number(await readFile(started,'utf8'));
    const marker=join(dir,`${bot}.quarantine.json`),record=JSON.parse(await readFile(marker,'utf8'));
    process.kill(record.pid,'SIGKILL');await rejected;await assert.rejects(lock.release(),/reconciliation required/);
    await assert.rejects(acquireEnvironmentLockForTests(dir,bot,executable),/ownership marker/);
    await until(()=>exists(completed),'orphan command did not demonstrate late side effect');
    assert.equal(await exists(marker),true);
  }finally{if(clientPid&&alive(clientPid))process.kill(clientPid,'SIGKILL');await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
});
test('nonzero lifecycle result and output overflow fail closed with permanent quarantine',async()=>{
  for(const mode of ['fail','overflow']){
    const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-')),bot=randomUUID();
    try{const lock=await acquireEnvironmentLockForTests(dir,bot,await fixture(dir));assert.ok(lock);await assert.rejects(lock.runner.command([mode]),mode==='fail'?/unverified daemon transport/:/output limit/);await assert.rejects(lock.release(),/quarantined/);assert.equal(await acquireEnvironmentLock(dir,bot),null);}
    finally{await manualCleanup(dir,bot);await rm(dir,{recursive:true,force:true});}
  }
});
test('OS mutex isolates bot identities and rejects traversal, symlink locks, symlink directories and markers',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chestnut-lock-'));let ids:string[]=[];
  try{
    ids=[randomUUID(),randomUUID()];const a=await acquireEnvironmentLock(dir,ids[0]),b=await acquireEnvironmentLock(dir,ids[1]);assert.ok(a&&b);await a.release();await b.release();
    await assert.rejects(acquireEnvironmentLock(dir,'../other'),/Invalid ID/);
    const id=randomUUID();await symlink('/tmp',join(dir,`${id}.lock`));await assert.rejects(acquireEnvironmentLock(dir,id),/symlink/);
    const linked=join(dir,'linked');await symlink(dir,linked);await assert.rejects(acquireEnvironmentLock(linked,randomUUID()),/Unsafe/);
    const marked=randomUUID();await symlink('/tmp',join(dir,`${marked}.quarantine.json`));await assert.rejects(acquireEnvironmentLock(dir,marked),/unsafe marker/);
  }finally{for(const id of ids)await manualCleanup(dir,id);await rm(dir,{recursive:true,force:true});}
});
