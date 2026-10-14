import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { assertResourceControls, assertRootless, PI_SOURCE_COMMIT } from '../sandbox/rootless-docker.ts';

export type Probe = (program:string, args:string[])=>Promise<string>;
export const probe:Probe = async (program,args) => (await promisify(execFile)(program,args,{timeout:10000,maxBuffer:2*1024*1024})).stdout;
export interface PreflightOptions { offline?:boolean; docker?:boolean; dataDir?:string; image?:string }
export interface PreflightHost { platform:string; uid:number|undefined; nodeVersion:string; run:Probe; dockerHost?:string }
export interface Check { name:string; state:'passed'|'blocked'|'not_run'; detail:string }
export async function validateNewDataDirectory(path:string, uid=process.getuid?.()):Promise<void> {
  if(!isAbsolute(path)||resolve(path)!==path||/[,\r\n\0]/.test(path))throw new Error('Choose a normalized absolute data path');
  try { await lstat(path); throw new Error('Data directory already exists; use a new disposable path, never production state'); }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(path),stat=await lstat(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(parent)!==parent||(stat.mode&0o022)!==0||(uid!==undefined&&stat.uid!==uid))throw new Error('Parent must be canonical, owned by this user, and not writable by others');
  await access(parent,constants.W_OK|constants.X_OK);
}
export async function preflight(options:PreflightOptions={},host:PreflightHost={platform:process.platform,uid:process.getuid?.(),nodeVersion:process.versions.node,run:probe,dockerHost:process.env.DOCKER_HOST}) {
  const checks:Check[]=[];
  let imageId:string|null=null;
  const add=(name:string,state:Check['state'],detail:string)=>checks.push({name,state,detail});
  add('node',Number(host.nodeVersion.split('.')[0])>=24?'passed':'blocked','Node 24+ required');
  add('linux',options.offline?'not_run':host.platform==='linux'?'passed':'blocked','Live execution requires Linux; offline checks do not verify it');
  add('ordinary-user',host.uid!==undefined&&host.uid!==0?'passed':'blocked','Dedicated ordinary OS user required; no sudo or rootful fallback');
  if(options.dataDir){try{await validateNewDataDirectory(options.dataDir,host.uid);add('new-data-directory','passed','New path; existing data will not be overwritten');}catch(error){add('new-data-directory','blocked',(error as Error).message);}}
  else add('new-data-directory','not_run','Supply --data-dir for a new disposable directory');
  if(!options.offline&&host.platform==='linux'){
    try{if(!(await host.run('flock',['--version'])).includes('util-linux'))throw new Error();add('flock','passed','util-linux detected; contention behavior still needs Linux tests');}catch{add('flock','blocked','util-linux flock unavailable; no host package installation attempted');}
  }else add('flock','not_run','Linux-only prerequisite');
  const image=options.image??`chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image))add('image','blocked','Invalid image reference');
  else if(options.docker&&!options.offline&&host.platform==='linux'&&host.uid!==0){
    try{
      const context=(await host.run('docker',['context','show'])).trim();
      const endpoint=JSON.parse(await host.run('docker',['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']));
      // Reject every configured remote route rather than depending on precedence
      // between DOCKER_HOST and DOCKER_CONTEXT. Both admitted choices are local.
      if(typeof endpoint!=='string'||!endpoint.startsWith('unix://')||(host.dockerHost&&!host.dockerHost.startsWith('unix://')))throw new Error('Only local Unix Docker endpoints are admitted');
      const info=JSON.parse(await host.run('docker',['info','--format','{{json .}}']));assertRootless(info);assertResourceControls(info);
      add('docker','passed','Local rootless daemon reports cgroup v2/systemd CPU, memory, swap and PID controls');
      const images=JSON.parse(await host.run('docker',['image','inspect',image]));
      if(!Array.isArray(images)||images.length!==1||!/^sha256:[a-f0-9]{64}$/.test(images[0].Id)||images[0].Os!=='linux'||!['amd64','arm64'].includes(images[0].Architecture)||images[0].Config?.Labels?.['org.chestnut.pi.commit']!==PI_SOURCE_COMMIT)throw new Error('Pinned Linux amd64/arm64 source image required');
      imageId=images[0].Id;
      add('image','passed',`Inspected immutable image ${images[0].Id}; runtime assets still need Docker acceptance`);
    }catch{add('docker-or-image','blocked','Local rootless daemon/resource controls or pinned image unavailable; no pull/build/settings changes attempted');}
  }else add('docker-and-image','not_run','Only --docker on Linux probes the local daemon; never builds or pulls');
  for(const name of ['disk-quota-enforcement','live-model','live-telegram','signed-package-download','service-continuity'])add(name,'not_run','Requires the separately authorized live gate');
  return {scope:options.offline?'offline':'host',checks,imageId,passed:checks.every(c=>c.state!=='blocked'),readyForDockerAcceptance:!options.offline&&!!options.docker&&!!options.dataDir&&checks.every(c=>c.state!=='blocked')&&checks.some(c=>c.name==='image'&&c.state==='passed'),operationallyVerified:false};
}
