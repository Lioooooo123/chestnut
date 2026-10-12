import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preflight, probe, validateNewDataDirectory } from '../src/deployment/preflight.ts';
import { acquireEnvironmentLock } from '../src/control/environment-lock.ts';
import { StableEnvironment } from '../src/environments/stable-docker.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';

const args=process.argv.slice(2),options={image:`chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`};let execute=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--execute')execute=true;
  else if(args[i]==='--data-dir'||args[i]==='--image'){const key=args[i]==='--image'?'image':'dataDir';if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing ${args[i]} value`);options[key]=args[++i];}
  else if(args[i]==='--help'){console.log('npm run acceptance:docker -- --execute --data-dir /new/disposable/path [--image existing-image]. Without --execute: plan only, no Docker contact or filesystem changes. Never uses production data, installs packages, pulls images, publishes ports, calls models or Telegram.');process.exit(0);}
  else throw new Error(`Unknown option ${args[i]}`);
}
const planned=['pinned image/runtime assets','two isolated stable Bot roots','background service across a second environment execution','whole-Bot stop/restart retains files and terminates services','verified stop and retained evidence'];
if(!execute){console.log(JSON.stringify({state:'not_run',planned,requires:'Explicit --execute, new --data-dir, Linux ordinary user and existing rootless source image'},null,2));process.exit(0);}
if(!options.dataDir)throw new Error('--data-dir is required');
await validateNewDataDirectory(options.dataDir);
const admission=await preflight({...options,docker:true});
if(!admission.readyForDockerAcceptance){console.log(JSON.stringify(admission,null,2));process.exit(1);}
// Freeze the inspected image; a later tag change cannot substitute another image.
options.image=admission.imageId;
const report={piCommit:PI_SOURCE_COMMIT,applicationCommit:(await probe('git',['rev-parse','HEAD'])).trim(),sourceDirty:!!(await probe('git',['status','--porcelain'])).trim(),scope:'model-less-live-docker',steps:[],bots:[],cleanup:[],notRun:['real Pi model/tool broker roundtrip','signed network package installation','live Telegram','worker SIGKILL against Docker','measured cgroup/disk enforcement']};
// Exclusive creation after all read-only admission; never open or reuse a runtime.
await mkdir(options.dataDir,{mode:0o700});
const owned=[];
let interrupted=false;
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
const step=async(name,fn)=>{if(interrupted)throw new Error('Acceptance interrupted; cleaning only this run');await fn();if(interrupted)throw new Error('Acceptance interrupted; cleaning only this run');report.steps.push({name,state:'passed'});};
const command=async(env,text)=>{const result=await env.execute(text,10000);if(result.code!==0||result.timedOut||result.truncated)throw new Error('Acceptance guest command failed or was uncertain');return result.stdout;};
try{
  for(let i=0;i<2;i++){
    if(interrupted)throw new Error('Acceptance interrupted before another Bot launch');
    const botId=randomUUID();await mkdir(join(options.dataDir,'bots',botId,'workspace'),{recursive:true,mode:0o700});
    const lock=await acquireEnvironmentLock(join(options.dataDir,'locks'),botId);if(!lock)throw new Error('Unexpected acceptance OS-lock contention');
    const entry={botId,lock,env:new StableEnvironment(botId,{dataRoot:options.dataDir,image:options.image,canMutate:()=>lock.isHeld(),canExecute:()=>lock.isHeld()&&!interrupted,onEnvironment:value=>{const current=report.bots.find(b=>b.botId===botId);if(current)Object.assign(current,value);else report.bots.push({botId,...value});}},lock.runner)};
    owned.push(entry);await entry.env.ensureRunning();
  }
  const [a,b]=owned;
  await step('bookworm/runtime assets available',()=>command(a.env,`node -e 'const fs=require("node:fs");if(!/VERSION_CODENAME=bookworm/.test(fs.readFileSync("/etc/os-release","utf8")))process.exit(1);for(const p of ["/usr/bin/apt-get","/usr/bin/apt-cache","/usr/bin/gpgv","/usr/bin/dpkg","/usr/bin/env","/etc/ssl/certs/ca-certificates.crt","/usr/share/keyrings/debian-archive-keyring.gpg","/opt/chestnut/environment-extension.mjs","/opt/pi/packages/coding-agent/dist/bundle/rpc-entry.js"])fs.accessSync(p)'`));
  await step('A writes root/workspace and starts container-loopback service',()=>command(a.env,`printf chestnut-acceptance > /opt/chestnut-acceptance.txt; printf owned-by-a > /workspace/acceptance.txt; node -e 'require("node:http").createServer((q,s)=>s.end("chestnut-acceptance")).listen(47831,"127.0.0.1")' > /tmp/chestnut-acceptance.log 2>&1 & echo $! > /tmp/chestnut-acceptance.pid`));
  await step('B cannot observe A files or service',()=>command(b.env,`test ! -e /opt/chestnut-acceptance.txt && test ! -e /workspace/acceptance.txt && node -e 'fetch("http://127.0.0.1:47831").then(()=>process.exit(1),()=>process.exit(0))'`));
  await step('second A execution reuses root and running service',async()=>{
    const next=new StableEnvironment(a.botId,{...a.env.options},a.lock.runner);await next.ensureRunning();
    await command(next,`test "$(cat /opt/chestnut-acceptance.txt)" = chestnut-acceptance && test "$(cat /workspace/acceptance.txt)" = owned-by-a && node -e '(async()=>{for(let i=0;i<50;i++){try{if(await(await fetch("http://127.0.0.1:47831")).text()==="chestnut-acceptance")return}catch{}await new Promise(r=>setTimeout(r,20))}process.exitCode=1})()'`);
  });
  await step('whole-Bot stop/restart retains files and stops the service',async()=>{
    await a.env.stop();await a.env.ensureRunning();await command(a.env,`test "$(cat /opt/chestnut-acceptance.txt)" = chestnut-acceptance && node -e 'fetch("http://127.0.0.1:47831").then(()=>process.exit(1),()=>process.exit(0))'`);
  });
}catch(error){report.error=String(error.message).slice(0,1000);process.exitCode=1;}
finally{
  for(const entry of owned.reverse()){
    try{await entry.env.stop();report.cleanup.push({botId:entry.botId,state:'verified_stopped_rootfs_retained'});}catch{report.cleanup.push({botId:entry.botId,state:'unverified_operator_review_required'});process.exitCode=1;}
    try{await entry.lock.release();}catch{report.cleanup.push({botId:entry.botId,state:'os_lock_quarantine_operator_review_required'});process.exitCode=1;}
  }
  if(interrupted){report.error??='Acceptance interrupted';process.exitCode=1;}
  report.state=process.exitCode?'failed_or_blocked':'passed_for_reported_scope';
  await writeFile(join(options.dataDir,'acceptance-evidence.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report,null,2));
  console.log('Only recorded acceptance Bot containers were stopped; rootfs and data are retained. Do not remove lock/quarantine files to force recovery. See docs/deployment-runbook.md.');
}
