import { join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { assertResourceControls, assertRootless, PI_SOURCE_COMMIT } from '../sandbox/rootless-docker.ts';
import type { DockerCommandRunner, PersistentEnvironmentState } from '../sandbox/persistent-docker.ts';

/** Stable execution environment has no model, memory, task session, or host control socket. */
export const ENVIRONMENT_CAPABILITIES = ['CHOWN','DAC_OVERRIDE','FOWNER','FSETID','SETGID','SETUID','NET_BIND_SERVICE'];
export interface StableOptions {
  dataRoot:string; image:string; canMutate:()=>boolean; canExecute:()=>boolean;
  expectedContainerId?:string|null; expectedImageId?:string|null;
  desktop?:boolean;
  onEnvironment?:(state:PersistentEnvironmentState)=>void;
}
const id=(value:string)=>{if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value))throw new Error('Invalid environment identity');return value;};
export const stableName=(botId:string)=>`chestnut-env-${id(botId)}`;
const path=(value:string)=>{if(resolve(value)!==value||/[,\r\n\0]/.test(value))throw new Error('Invalid environment path');return value;};
export function stableCreateArgs(botId:string,o:StableOptions):string[]{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(o.image))throw new Error('Invalid environment image');
  return ['create','--name',stableName(botId),'--init','--network','none','--ipc','private','--cgroupns','private',
    '--label',`chestnut.bot=${botId}`,'--label','chestnut.profile=service-v1','--label','chestnut.schema=1',
    '--cap-drop','ALL',...ENVIRONMENT_CAPABILITIES.flatMap(cap=>['--cap-add',cap]),'--security-opt','no-new-privileges',
    '--pids-limit','128','--memory','1024m','--memory-swap','1024m','--cpus','1','--user','0:0','--workdir','/workspace',
    '--mount',`type=bind,source=${path(join(resolve(o.dataRoot),'bots',id(botId),'workspace'))},target=/workspace`,
    ...(o.desktop?['--tmpfs','/tmp:rw,nosuid,nodev,size=268435456,mode=1777']:[]),
    '--entrypoint','node',o.image,'-e','setInterval(() => {}, 60000)'];
}
export function verifyStableInspection(c:any,botId:string,o:StableOptions,imageId:string):void{
  const h=c?.HostConfig,config=c?.Config;
  if(!c?.Id||c.Image!==imageId||(o.expectedContainerId&&c.Id!==o.expectedContainerId)||(o.expectedImageId&&c.Image!==o.expectedImageId))throw new Error('Stable environment identity changed; explicit recovery required');
  if(config?.Image!==o.image||config.User!=='0:0'||config.Labels?.['chestnut.bot']!==botId||config.Labels?.['chestnut.profile']!=='service-v1'||config.Labels?.['chestnut.schema']!=='1')throw new Error('Stable environment configuration mismatch');
  if(JSON.stringify(config.Entrypoint)!==JSON.stringify(['node'])||JSON.stringify(config.Cmd)!==JSON.stringify(['-e','setInterval(() => {}, 60000)']))throw new Error('Stable environment startup mismatch');
  if(!h||h.NetworkMode!=='none'||h.Privileged||h.ReadonlyRootfs||h.AutoRemove||h.PublishAllPorts||h.Init!==true||JSON.stringify([...(h.CapDrop??[])].map((v:string)=>v.toUpperCase()).sort())!==JSON.stringify(['ALL'])||JSON.stringify([...(h.CapAdd??[])].map((v:string)=>v.toUpperCase()).sort())!==JSON.stringify([...ENVIRONMENT_CAPABILITIES].sort())||JSON.stringify(h.SecurityOpt)!==JSON.stringify(['no-new-privileges']))throw new Error('Stable environment isolation mismatch');
  if(h.Devices?.length||h.DeviceRequests?.length||h.ExtraHosts?.length||h.VolumesFrom?.length||h.Binds?.length||Object.keys(h.PortBindings??{}).length||(h.PidMode&&h.PidMode!=='')||h.IpcMode!=='private'||h.CgroupnsMode!=='private'||(h.UTSMode&&h.UTSMode!=='')||(h.UsernsMode&&h.UsernsMode!=='')||(h.RestartPolicy?.Name&&h.RestartPolicy.Name!=='no'))throw new Error('Stable environment unauthorized host access');
  if(h.Memory!==1073741824||h.MemorySwap!==1073741824||h.PidsLimit!==128||h.NanoCpus!==1000000000)throw new Error('Stable environment resource controls mismatch');
  const mounts=c.Mounts;
  const workspace=Array.isArray(mounts)?mounts.find(m=>m.Destination==='/workspace'):null;
  if(!Array.isArray(mounts)||mounts.length!==(o.desktop?2:1)||workspace?.Type!=='bind'||workspace.Source!==join(resolve(o.dataRoot),'bots',botId,'workspace')||workspace.RW!==true||(workspace.Propagation&&workspace.Propagation!=='rprivate')||JSON.stringify(h.Tmpfs??{})!==JSON.stringify(o.desktop?{'/tmp':'rw,nosuid,nodev,size=268435456,mode=1777'}:{})||(o.desktop&&!mounts.some(m=>m.Type==='tmpfs'&&m.Destination==='/tmp'&&m.RW===true)))throw new Error('Stable environment mounts mismatch; no task or broker mounts allowed');
  const allowed=new Set(['PATH','NODE_VERSION','YARN_VERSION','HOME','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_NO_UPDATE_CHECK']);
  if(config.Env?.some((e:string)=>!allowed.has(e.split('=',1)[0])))throw new Error('Unexpected stable environment variable');
}
export class StableEnvironment {
  readonly botId:string; readonly options:StableOptions; readonly runner:DockerCommandRunner;
  constructor(botId:string,options:StableOptions,runner:DockerCommandRunner){this.botId=id(botId);this.options={...options};this.runner=runner;}
  private fence(execute=false){if(!this.options.canMutate()||(execute&&!this.options.canExecute()))throw new Error('Environment execution grant closed');}
  private async image(requireResources=true){this.fence();const info=JSON.parse(await this.runner.command(['info','--format','{{json .}}']));this.fence();assertRootless(info);if(requireResources)assertResourceControls(info);
    if(!requireResources&&this.options.expectedImageId)return this.options.expectedImageId;
    const image=JSON.parse(await this.runner.command(['image','inspect',this.options.image]));this.fence();
    if(!Array.isArray(image)||image.length!==1||typeof image[0].Id!=='string'||image[0].Config?.Labels?.['org.chestnut.pi.commit']!==PI_SOURCE_COMMIT)throw new Error('Stable environment requires the pinned source image');if(this.options.desktop&&(image[0].Config?.Labels?.['org.chestnut.desktop']!=='1'||image[0].Config?.Labels?.['org.chestnut.desktop.browser']!=='chromium'))throw new Error('Build the desktop source image first; sandbox fallback is forbidden');return image[0].Id as string;}
  private async inspect(){this.fence();const names=(await this.runner.command(['container','ls','--all','--filter',`name=^/${stableName(this.botId)}$`,'--format','{{.ID}}'])).trim();this.fence();if(!names)return undefined;
    const values=JSON.parse(await this.runner.command(['container','inspect',stableName(this.botId)]));this.fence();if(!Array.isArray(values)||values.length!==1)throw new Error('Invalid stable environment inspection');return values[0];}
  private observe(c:any){this.options.expectedContainerId??=c.Id;this.options.expectedImageId??=c.Image;this.options.onEnvironment?.({containerId:c.Id,imageId:c.Image,state:c.State.Running?'running':'stopped'});}
  async inspection(){const image=await this.image(),c=await this.inspect();verifyStableInspection(c,this.botId,this.options,image);return c;}
  async desktopCommand(wrapper:string,input:unknown){this.fence(true);if(!this.options.desktop)throw new Error('Desktop is not enabled');const c=await this.inspection();if(!c.State.Running)throw new Error('Desktop environment is stopped');this.fence(true);const output=await this.runner.command(['exec','--user','1000:1000',stableName(this.botId),'node','-e',wrapper,JSON.stringify(input)],20000);this.fence(true);return output;}
  async ensureRunning(){this.fence(true);const workspace=join(resolve(this.options.dataRoot),'bots',this.botId,'workspace');
    if(await realpath(workspace)!==workspace||(await lstat(workspace)).isSymbolicLink())throw new Error('Stable workspace must be canonical');
    const image=await this.image();let c=await this.inspect();this.fence(true);
    if(!c){if(this.options.expectedContainerId)throw new Error('Recorded stable root filesystem missing; automatic replacement forbidden');await this.runner.command(stableCreateArgs(this.botId,this.options),30000);this.fence(true);c=await this.inspect();}
    verifyStableInspection(c,this.botId,this.options,image);this.observe(c);this.fence(true);
    if(c.State.Paused||c.State.Restarting)throw new Error('Stable environment state requires recovery');
    if(!c.State.Running){await this.runner.command(['container','start',stableName(this.botId)]);this.fence(true);c=await this.inspect();verifyStableInspection(c,this.botId,this.options,image);}
    if(!c.State.Running)throw new Error('Stable environment did not start');this.observe(c);
  }
  async stop(){const image=await this.image(false);let c=await this.inspect();if(!c){if(this.options.expectedContainerId)throw new Error('Recorded stable root filesystem missing');return;}
    verifyStableInspection(c,this.botId,this.options,image);this.fence();
    if(c.State.Running||c.State.Paused||c.State.Restarting)await this.runner.command(['container','stop','--time','2',stableName(this.botId)],20000);
    c=await this.inspect();verifyStableInspection(c,this.botId,this.options,image);if(c.State.Running||c.State.Paused||c.State.Restarting)throw new Error('Stable environment stop unverified');this.observe(c);
  }
  async execute(command:string,timeoutMs=30000):Promise<{stdout:string;stderr:string;code:number|null;timedOut:boolean;truncated:boolean}>{
    if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>60000)throw new Error('Command must be 1-60000 bytes');
    if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>90000)throw new Error('Command timeout must be 100-90000 ms');this.fence(true);
    const image=await this.image(),c=await this.inspect();verifyStableInspection(c,this.botId,this.options,image);if(!c.State.Running)throw new Error('Stable environment is stopped');this.fence(true);
    // Wrapper is passed by trusted argv, not read from the writable guest. Guest results remain untrusted.
    const result=await this.runner.command(['exec','--workdir','/workspace',stableName(this.botId),'node','-e',COMMAND_WRAPPER,command,String(timeoutMs)],timeoutMs+5000);this.fence(true);
    let value:any;try{value=JSON.parse(result);}catch{throw new Error('Invalid environment command response');}
    if(!value||typeof value.stdout!=='string'||typeof value.stderr!=='string'||!(value.code===null||(Number.isInteger(value.code)&&value.code>=0&&value.code<=255))||typeof value.timedOut!=='boolean'||typeof value.truncated!=='boolean'||Buffer.byteLength(value.stdout)+Buffer.byteLength(value.stderr)>140000)throw new Error('Invalid environment command result');
    return {stdout:value.stdout,stderr:value.stderr,code:typeof value.code==='number'?value.code:null,timedOut:value.timedOut===true,truncated:value.truncated===true};
  }
}
export const COMMAND_WRAPPER=`const{spawn}=require('node:child_process');const child=spawn('/bin/sh',['-lc',process.argv[1]],{cwd:'/workspace',detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HOME:'/root'}});let stdout='',stderr='',truncated=false,timedOut=false,done=false;const collect=(s,c)=>{const n=s+c;if(Buffer.byteLength(n)>65536){truncated=true;return Buffer.from(n).subarray(0,65536).toString('utf8')}return n};child.stdout.on('data',c=>stdout=collect(stdout,c));child.stderr.on('data',c=>stderr=collect(stderr,c));const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},Number(process.argv[2]));const finish=code=>{if(done)return;done=true;clearTimeout(timer);console.log(JSON.stringify({stdout,stderr,code,timedOut,truncated}))};child.on('error',e=>{stderr=e.message;finish(127)});child.on('close',finish);`;
