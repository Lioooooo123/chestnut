import { preflight,probe,type Probe,type Check } from './preflight.ts';
export interface MacPreflightOptions {profile?:string;image?:string}
export interface MacPreflightHost {platform:string;uid:number|undefined;nodeVersion:string;run:Probe}
/** Read existing Colima state only. Never starts/creates a VM or changes context. */
export async function macPreflight(options:MacPreflightOptions={},host:MacPreflightHost={platform:process.platform,uid:process.getuid?.(),nodeVersion:process.versions.node,run:probe}){
  const profile=options.profile??'default';if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))throw new Error('Invalid existing Colima profile');
  const checks:Check[]=[],add=(name:string,state:Check['state'],detail:string)=>checks.push({name,state,detail});
  const result=()=>({scope:'mac-linux-vm',profile,checks,passed:checks.every(c=>c.state!=='blocked'),readyForGuestAcceptance:checks.every(c=>c.state!=='blocked')&&checks.some(c=>c.name==='guest-image'&&c.state==='passed'),operationallyVerified:false,executionDomain:'API, Worker, locks, brokers, Docker paths and snapshots must all stay in the same Linux guest. Native macOS Unix sockets are not a supported VM mount.'});
  add('mac-host',host.platform==='darwin'?'passed':'blocked','This entry inspects an existing Colima Linux VM on macOS');
  add('host-node',Number(host.nodeVersion.split('.')[0])>=24?'passed':'blocked','Host launcher needs Node 24+');
  add('ordinary-host-user',host.uid!==undefined&&host.uid!==0?'passed':'blocked','Run the launcher as the ordinary Mac user; no sudo');
  if(checks.some(c=>c.state==='blocked'))return result();
  let rows:any[];
  try{const output=await host.run('colima',['list','--json']);rows=output.trim()?output.trim().split('\n').flatMap(line=>{const value=JSON.parse(line);return Array.isArray(value)?value:[value];}):[];add('colima-cli','passed','Existing Colima CLI responded; no install attempted');}
  catch{add('colima-cli','blocked','Colima unavailable or state unreadable. No runtime installed or started.');return result();}
  const vm=rows.find(row=>row.name===profile);
  if(!vm){add('existing-profile','blocked','Requested profile does not exist; no new VM created');return result();}
  add('existing-profile','passed',`Existing ${profile} profile; architecture ${['aarch64','x86_64'].includes(vm.arch)?vm.arch:'unknown'}`);
  if(typeof vm.status!=='string'||vm.status.toLowerCase()!=='running'){add('running-vm','blocked','Existing profile is stopped or not ready. Operator must separately approve starting it; this command never starts it.');return result();}
  add('running-vm','passed','Existing profile reports running; guest prerequisites still checked');
  const guest:Probe=(program,args)=>host.run('colima',['--profile',profile,'ssh','--',...(program==='docker'?['env','-u','DOCKER_HOST','-u','DOCKER_CONTEXT']:[]),program,...args]);
  let uid:number,nodeVersion:string;
  try{if((await guest('uname',['-s'])).trim()!=='Linux')throw new Error();const text=(await guest('id',['-u'])).trim();if(!/^\d+$/.test(text))throw new Error();uid=Number(text);}
  catch{add('guest-tools','blocked','Cannot verify Linux guest and ordinary user. No guest packages installed.');return result();}
  try{nodeVersion=(await guest('node',['-p','process.versions.node'])).trim();if(!/^\d+\.\d+\.\d+$/.test(nodeVersion))nodeVersion='0.0.0';}catch{nodeVersion='0.0.0';}
  const report=await preflight({docker:true,image:options.image},{platform:'linux',uid,nodeVersion,run:guest});
  for(const check of report.checks)checks.push({...check,name:`guest-${check.name}`});
  add('guest-storage-and-sockets','not_run','Runtime files must use a new private guest-native path, not a Mac shared folder. Actual mounts, broker sockets and crash recovery require acceptance.');
  return result();
}
