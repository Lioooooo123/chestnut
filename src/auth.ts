import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, requireId } from './types.ts';
export interface OAuthCredential { type:'oauth';access:string;refresh:string;expires:number;clientId?:unknown;scopes?:unknown;[key:string]:unknown }
interface Interaction {signal:AbortSignal;notify(event:{type:string;url?:string;message?:string}):void;prompt(options:{type:string;signal?:AbortSignal;[key:string]:unknown}):Promise<string>}
export interface OAuthFlow {login(interaction:Interaction,options:{agentName:string;getDeviceId:()=>string}):Promise<OAuthCredential>;refresh(credential:OAuthCredential,signal:AbortSignal):Promise<OAuthCredential>}
/** A task may refresh its token, but must never migrate its context to a new grant. */
export interface AuthGrant { readonly model:string|null; isCurrent():boolean; apiKey(signal?:AbortSignal):Promise<string> }
interface Stored {deviceId:string;revision:number;generation?:number;preferred?:boolean;model?:string;credential?:OAuthCredential;lastRequestId?:string}
interface Login {id:string;state:'starting'|'awaiting'|'connected'|'failed'|'cancelled';url?:string;error?:string}
/** Credential files stay in trusted control storage, never in Git, guest mounts, API status or logs. */
export class AuthManager {
  readonly root:string;private readonly file:string;private readonly injected?:OAuthFlow;private readonly transport:typeof fetch;private login?:Login;private controller?:AbortController;private work?:Promise<void>;private manual?:{resolve:(value:string)=>void;reject:(error:Error)=>void};
  constructor(root:string,flow?:OAuthFlow,transport:typeof fetch=fetch){
    this.root=resolve(root);this.file=join(this.root,'auth.json');this.injected=flow;this.transport=transport;
    mkdirSync(this.root,{recursive:true,mode:0o700});if(realpathSync(this.root)!==this.root||lstatSync(this.root).isSymbolicLink())throw new Error('Unsafe auth storage');chmodSync(this.root,0o700);
    if(!existsSync(this.file)) {const db=this.db();try{db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');if(!existsSync(this.file))this.write({deviceId:randomUUID(),revision:0});db.exec('COMMIT');}finally{db.close();}}
    this.read();
  }
  private db(){const path=join(this.root,'auth.lock.sqlite');if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Unsafe auth lock');const db=new DatabaseSync(path);chmodSync(path,0o600);return db;}
  private read():Stored{
    if(lstatSync(this.file).isSymbolicLink()||(lstatSync(this.file).mode&0o077)!==0)throw new AppError(500,'Auth storage must be a private regular file');
    try{const value=JSON.parse(readFileSync(this.file,'utf8')) as Stored;requireId(value.deviceId);if(!Number.isSafeInteger(value.revision)||(value.generation!==undefined&&(!Number.isSafeInteger(value.generation)||value.generation<0)))throw 0;return value;}catch{throw new AppError(500,'Auth storage is invalid; inspect it on the host');}
  }
  private write(value:Stored){const path=join(this.root,`${randomUUID()}.tmp`);writeFileSync(path,JSON.stringify(value),{mode:0o600,flag:'wx'});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(path,this.file);const dir=openSync(this.root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
  private async locked<T>(fn:(state:Stored)=>Promise<T>):Promise<T>{
    const db=this.db();const until=Date.now()+35000;let held=false;
    try{while(!held){try{db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');held=true;}catch{if(Date.now()>until)throw new AppError(409,'Authentication is busy; retry');await sleep(40);}}
      try{const result=await fn(this.read());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
    }finally{db.close();}
  }
  private async flow():Promise<OAuthFlow>{return this.injected??(await import(new URL('../vendor/pi/packages/ai/src/auth/oauth/openai-chatgpt.ts',import.meta.url).href)).openaiChatGPTOAuth;}
  private validate(value:OAuthCredential){if(value?.type!=='oauth'||typeof value.access!=='string'||!value.access||typeof value.refresh!=='string'||!value.refresh||!Number.isFinite(value.expires)||typeof value.clientId!=='string'||!value.clientId||!Array.isArray(value.scopes)||!value.scopes.includes('chatgpt.tokens.use.direct'))throw new AppError(400,'ChatGPT direct model permission was not granted');}
  status(){const state=this.read();return {connected:!!state.credential,preferred:state.preferred??false,model:state.model??null,expiresAt:state.credential?.expires??null,login:this.login?{...this.login}:state.lastRequestId&&state.credential?{id:state.lastRequestId,state:'connected' as const}:null};}
  async startLogin(id:string){
    requireId(id);const stored=this.read();if(stored.lastRequestId===id&&stored.credential)return this.status();if(this.login?.id===id)return this.status();
    if(this.work&&['starting','awaiting'].includes(this.login?.state??''))throw new AppError(409,'A ChatGPT sign-in is already pending');
    this.controller=new AbortController();const controller=this.controller;this.login={id,state:'starting'};
    let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});const timer=setTimeout(()=>controller.abort(),15*60000);timer.unref();
    this.work=(async()=>{
      try{
        const flow=await this.flow();const credential=await flow.login({signal:controller.signal,notify:event=>{
          if(event.type==='auth_url'&&event.url){const url=new URL(event.url);if(url.origin!=='https://auth.openai.com'||url.pathname!=='/api/accounts/authorize')throw new Error('Invalid auth URL');this.login={id,state:'awaiting',url:url.href};ready();}
        },prompt:options=>new Promise((resolvePrompt,rejectPrompt)=>{
          const signal=options.signal??controller.signal;const abort=()=>{this.manual=undefined;rejectPrompt(new Error('Login cancelled'));};
          this.manual={resolve:value=>{signal.removeEventListener('abort',abort);this.manual=undefined;resolvePrompt(value);},reject:rejectPrompt};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        })},{agentName:'Chestnut',getDeviceId:()=>stored.deviceId});
        this.validate(credential);await this.locked(async state=>{if(controller.signal.aborted||(state.generation??0)!==(stored.generation??0))throw new Error('Login revoked');this.write({...state,credential,preferred:true,model:undefined,generation:(state.generation??0)+1,revision:state.revision+1,lastRequestId:id});});this.login={id,state:'connected'};
      }catch{this.login={id,state:controller.signal.aborted?'cancelled':'failed',error:controller.signal.aborted?'Sign-in cancelled.':'ChatGPT sign-in failed. Check the callback tunnel or retry.'};}
      finally{clearTimeout(timer);this.manual=undefined;ready();}
    })();
    await Promise.race([started,this.work]);return this.status();
  }
  submitCallback(id:string,url:string){requireId(id);if(id!==this.login?.id||!this.manual||typeof url!=='string'||url.length>16000)throw new AppError(409,'No matching sign-in is awaiting a callback');this.manual.resolve(url);return this.status();}
  wait(){return this.work??Promise.resolve();}
  close(){this.controller?.abort();}
  async logout(){this.close();await this.locked(async state=>{delete state.credential;this.write({...state,model:undefined,generation:(state.generation??0)+1,revision:state.revision+1});});return this.status();}
  async models(){
    const grant=this.grant();const key=await grant.apiKey();
    if(!grant.isCurrent())throw new AppError(409,'ChatGPT account changed; reload models');
    let response:Response;try{response=await this.transport('https://api.openai.com/v1/models',{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new AppError(502,'Unable to load ChatGPT models');}
    if(!response.ok){await response.body?.cancel();throw new AppError(response.status===401?401:502,'Unable to load models for this ChatGPT account');}
    const text=await response.text();if(text.length>2000000)throw new AppError(502,'Model catalog exceeded limit');
    let models:{id:string;name:string}[];
    try{const data=JSON.parse(text);if(!Array.isArray(data.models))throw 0;models=data.models.filter((m:any)=>m.visibility==='list'&&typeof m.slug==='string'&&/^[a-z0-9][a-z0-9_.-]{0,199}$/i.test(m.slug)).map((m:any)=>({id:m.slug,name:typeof m.display_name==='string'&&!m.display_name.includes(key)?m.display_name.slice(0,160):m.slug}));}catch{throw new AppError(502,'Invalid ChatGPT model catalog');}
    if(!grant.isCurrent())throw new AppError(409,'ChatGPT account changed; reload models');
    return models;
  }
  async selectModel(id:string){const generation=this.read().generation??0;const models=await this.models();if(!models.some(m=>m.id===id))throw new AppError(400,'Select a model available to this ChatGPT account');await this.locked(async state=>{if(!state.credential||(state.generation??0)!==generation)throw new AppError(409,'ChatGPT account changed; reload models');this.write({...state,model:id,generation:generation+(state.model===id?0:1),revision:state.revision+1});});return this.status();}
  grant():AuthGrant{
    const state=this.read();if(!state.credential)throw new AppError(401,'Sign in with ChatGPT before running real tasks');
    this.validate(state.credential);const generation=state.generation??0;
    return Object.freeze({model:state.model??null,isCurrent:()=>{try{const current=this.read();return !!current.credential&&(current.generation??0)===generation;}catch{return false;}},apiKey:(signal?:AbortSignal)=>this.keyForGeneration(generation,signal)});
  }
  async apiKey(signal?:AbortSignal){return this.grant().apiKey(signal);}
  private async keyForGeneration(generation:number,signal:AbortSignal=AbortSignal.timeout(30000)){
    const check=(state:Stored)=>{signal.throwIfAborted();if(!state.credential||(state.generation??0)!==generation)throw new AppError(409,'ChatGPT account or model changed; start a new task');};
    const state=this.read();check(state);
    // check() establishes the credential, without returning it on the grant object.
    if(!state.credential)throw new AppError(401,'Sign in with ChatGPT before running real tasks');
    this.validate(state.credential);if(state.credential.expires>Date.now()+30000)return state.credential.access;
    return this.locked(async current=>{
      check(current);
      if(!current.credential)throw new AppError(401,'Sign in with ChatGPT before running real tasks');
      if(current.credential.expires>Date.now()+30000)return current.credential.access;
      try{const flow=await this.flow();signal.throwIfAborted();const refreshed=await flow.refresh(current.credential,signal);check(this.read());this.validate(refreshed);this.write({...current,credential:refreshed,revision:current.revision+1});return refreshed.access;}
      catch{throw new AppError(401,'ChatGPT session could not be renewed. Sign in again.');}
    });
  }
}
