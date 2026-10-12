import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir,lstat,realpath,open } from 'node:fs/promises';
import { join,resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireId } from '../types.ts';
import type { DockerAttachment, DockerCommandRunner } from '../sandbox/persistent-docker.ts';

export interface EnvironmentLock { runner:DockerCommandRunner; isHeld():boolean; release():Promise<void> }
const MAX_FRAME=8*1024*1024,MAX_LINE=1024*1024;
/** All Docker clients live in the flock holder, which outlives a dead worker until they are reaped. */
export async function acquireEnvironmentLock(directory:string,botId:string):Promise<EnvironmentLock|null>{
  return acquire(directory,botId);
}
/** Explicit local fixture seam for tests. Production acquisition always executes exactly `docker`. */
export async function acquireEnvironmentLockForTests(directory:string,botId:string,fixtureExecutable:string):Promise<EnvironmentLock|null>{
  if(!isAbsolute(fixtureExecutable)||(await lstat(fixtureExecutable)).isSymbolicLink()||!(await lstat(fixtureExecutable)).isFile()||await realpath(fixtureExecutable)!==fixtureExecutable)throw new Error('Invalid local Docker test fixture');
  return acquire(directory,botId,fixtureExecutable);
}
async function acquire(directory:string,botId:string,fixtureExecutable?:string):Promise<EnvironmentLock|null>{
  requireId(botId);await mkdir(directory,{recursive:true,mode:0o700});
  const directoryStat=await lstat(directory);
  if(await realpath(directory)!==resolve(directory)||directoryStat.isSymbolicLink()||!directoryStat.isDirectory()||(directoryStat.mode&0o022)!==0||(process.getuid&&directoryStat.uid!==process.getuid()))throw new Error('Unsafe environment-lock directory');
  const path=join(resolve(directory),`${botId}.lock`),markerPath=join(resolve(directory),`${botId}.quarantine.json`);
  try{if((await lstat(path)).isSymbolicLink())throw new Error('Environment lock cannot be a symlink');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  // Open without following symlinks, then flock the pinned inode through inherited fd 3.
  const fd=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  const lockStat=await fd.stat();
  if(!lockStat.isFile()||lockStat.nlink!==1){await fd.close();throw new Error('Environment lock must be a regular file without hard links');}
  const holderArgs=[fileURLToPath(new URL('./lock-holder.mjs',import.meta.url)),markerPath];
  if(fixtureExecutable)holderArgs.push('--test-docker-fixture',fixtureExecutable);
  const child=spawn('flock',['--exclusive','--nonblock','--no-fork','/proc/self/fd/3',process.execPath,...holderArgs],{stdio:['pipe','pipe','pipe',fd.fd],shell:false});
  // Do not await after spawn until every child listener is installed: a contending
  // nonblocking flock may already exit while an asynchronous fd.close is pending.
  const stdin=child.stdin!,stdout=child.stdout!,stderr=child.stderr!;
  let held=false,released=false,closed=false,ready=false,poison:Error|undefined,buffer='',errors='',nextId=1;
  let resolveClosed:()=>void=()=>{},rejectPoison:(error:Error)=>void=()=>{},resolveReady:(value:boolean)=>void=()=>{},rejectReady:(error:Error)=>void=()=>{};
  const exit=new Promise<void>(resolveExit=>{resolveClosed=resolveExit;});
  const poisoned=new Promise<never>((_,reject)=>{rejectPoison=reject;});poisoned.catch(()=>{});
  const acquired=new Promise<boolean>((resolveAcquire,reject)=>{resolveReady=resolveAcquire;rejectReady=reject;});
  type Pending={resolve:(value:string)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout};
  type Attached={listener?:(line:string)=>void;closeListener?:(error?:Error)=>void;lines:string[];bytes:number;closed:boolean;error?:Error;terminate?:Promise<void>};
  const pending=new Map<number,Pending>(),attachments=new Map<number,Attached>();
  const instruction=(reason:string)=>new Error(`${reason.slice(0,1500)} Operator reconciliation required for ${markerPath}; holder PID ${child.pid ?? 'unknown'}. Do not remove the lock file.`);
  function fail(error:Error){
    if(poison)return;poison=error;held=false;rejectPoison(error);rejectReady(error);
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();
    for(const attachment of attachments.values())closeAttachment(attachment,error);attachments.clear();
  }
  function closeAttachment(attachment:Attached,error:Error){if(attachment.closed)return;attachment.closed=true;attachment.error=error;attachment.closeListener?.(error);}
  function transmit(message:unknown):Promise<void>{
    return new Promise((resolveWrite,reject)=>{if(closed||stdin.destroyed){reject(poison??instruction('Environment lock transport is closed.'));return;}stdin.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolveWrite());});
  }
  function abandon(reason:string){
    const error=instruction(reason);void transmit({type:'poison',id:nextId++,reason}).catch(()=>{});fail(error);return error;
  }
  function request(type:string,body:Record<string,unknown>,timeoutMs=125_000):Promise<string>{
    if(!held||released||poison)return Promise.reject(poison??new Error('Environment lock is not held'));
    if(pending.size>=64)return Promise.reject(new Error('Too many environment-lock requests'));
    const id=nextId++;
    return new Promise((resolveRequest,reject)=>{
      const timer=setTimeout(()=>abandon(`Environment lock ${type} response timed out; Docker outcome is unverified.`),timeoutMs);
      pending.set(id,{resolve:resolveRequest,reject,timer});
      void transmit({type,id,...body}).catch(error=>abandon(`Environment lock write failed: ${String(error)}`));
    });
  }
  function validArgs(args:string[]){if(!Array.isArray(args)||!args.length||args.length>256||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||Buffer.byteLength(JSON.stringify(args))>128*1024)throw new Error('Invalid trusted Docker arguments');}
  stdout.setEncoding('utf8');stderr.setEncoding('utf8');
  stderr.on('data',(chunk:string)=>{errors=(errors+chunk).slice(-4096);});
  stdout.on('data',(chunk:string)=>{
    if(poison)return;
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>MAX_FRAME){abandon('Environment lock output frame exceeded limit.');return;}
    let index:number;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      try{
        const message=JSON.parse(line);
        if(message.type==='ready'){ready=true;held=true;resolveReady(true);}
        else if(message.type==='failed')fail(instruction(String(message.error)));
        else if(message.type==='poison')fail(instruction(String(message.error)));
        else if(message.type==='result'){
          const item=pending.get(message.id);if(!item)continue;pending.delete(message.id);clearTimeout(item.timer);
          if(message.error)item.reject(new Error(String(message.error).slice(0,4096)));else item.resolve(typeof message.output==='string'?message.output:'');
        }else if(message.type==='line'){
          const attachment=attachments.get(message.attachmentId);if(!attachment||attachment.closed)continue;
          if(typeof message.line!=='string'||Buffer.byteLength(message.line)>MAX_LINE)throw new Error('invalid attachment frame');
          if(attachment.listener)attachment.listener(message.line);
          else{attachment.bytes+=Buffer.byteLength(message.line);if(attachment.bytes>2*MAX_LINE||attachment.lines.length>=1024)throw new Error('attachment listener backlog exceeded limit');attachment.lines.push(message.line);}
        }else if(message.type==='closed'){
          const attachment=attachments.get(message.attachmentId);if(attachment){closeAttachment(attachment,new Error(String(message.error??'Docker attachment closed').slice(0,4096)));attachments.delete(message.attachmentId);}
        }else if(message.type!=='released')throw new Error('unexpected holder message');
      }catch(error){abandon(`Invalid environment lock response: ${String(error)}`);return;}
    }
  });
  stdin.on('error',error=>{if(!released)abandon(`Environment lock input pipe failed: ${error.message}`);});
  stdout.on('error',error=>{if(!released)abandon(`Environment lock output pipe failed: ${error.message}`);});
  child.on('error',error=>fail(instruction(`Persistent profile needs util-linux flock: ${error.message}`)));
  child.on('close',(code)=>{
    held=false;closed=true;resolveClosed();
    if(!ready&&code===1&&!poison){resolveReady(false);return;}
    if(!released||code!==0)fail(instruction(`Environment lock helper exited (${code}): ${errors}`));
  });
  const startupTimer=setTimeout(()=>{abandon('Environment lock helper did not become ready.');stdin.end();child.unref();stdout.destroy();stderr.destroy();},5000);
  let available:boolean;
  try{[available]=await Promise.all([acquired,fd.close()]);}catch(error){stdin.end();child.unref();stdout.destroy();stderr.destroy();throw error;}finally{clearTimeout(startupTimer);}
  if(!available){await exit;return null;}
  const runner:DockerCommandRunner={
    command(args,timeoutMs=15_000){
      validArgs(args);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)return Promise.reject(new Error('Invalid Docker command timeout'));
      return request('command',{args,timeoutMs},timeoutMs+5000);
    },
    attach(args){
      validArgs(args);if(!held||released||poison)throw poison??new Error('Environment lock is not held');if(attachments.size>=16)throw new Error('Too many Docker attachments');
      const id=nextId++,attachment:Attached={lines:[],bytes:0,closed:false};attachments.set(id,attachment);
      void transmit({type:'start_attach',id,args}).catch(error=>abandon(`Cannot start Docker attachment: ${String(error)}`));
      const result:DockerAttachment={
        write:line=>{if(attachment.closed)return Promise.reject(attachment.error);if(Buffer.byteLength(line)>MAX_LINE)return Promise.reject(new Error('Docker attachment write exceeded limit'));return request('write',{attachmentId:id,line}).then(()=>{});},
        onLine:listener=>{attachment.listener=listener;for(const line of attachment.lines)listener(line);attachment.lines=[];attachment.bytes=0;},
        onClose:listener=>{attachment.closeListener=listener;if(attachment.closed)listener(attachment.error);},
        terminate:()=>attachment.terminate??=(attachment.closed?Promise.resolve():request('terminate',{attachmentId:id},5000).then(()=>{})),
      };return result;
    },
  };
  let releasePromise:Promise<void>|undefined;
  return {runner,isHeld:()=>held&&!released&&!poison,release(){return releasePromise??=(async()=>{
    released=true;held=false;stdin.end();
    let timer:NodeJS.Timeout|undefined;
    try{if(poison)throw poison;await Promise.race([exit,poisoned,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(abandon('Environment lock release could not verify helper exit.')),125_000);})]);if(poison)throw poison;}
    finally{if(timer)clearTimeout(timer);if(poison){child.unref();stdout.destroy();stderr.destroy();stdin.destroy();}}
  })();}};
}
