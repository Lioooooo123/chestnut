import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validPackage } from './package-policy.ts';
import { AppError, requireId } from '../types.ts';
import type { StableEnvironment } from './stable-docker.ts';
export interface EnvironmentBrokerOptions {socketPath:string;environment:Pick<StableEnvironment,'execute'>;authorize:()=>boolean;onEvent?:(type:string,data:unknown)=>void;installPackages?:(packages:string[],requestId:string)=>Promise<unknown>;fetchUrl?:(url:string)=>Promise<unknown>}
/** Per-run broker. Mounted only into the disposable Pi runner, never the stable environment. */
export function createEnvironmentHandler(o:EnvironmentBrokerOptions){
  let active=false,closed=false,healthy=true,receiptBytes=0;
  let pending:Promise<unknown>|undefined;
  const receipts=new Map<string,{hash:string;state:'pending'|'done'|'uncertain';value?:unknown}>();
  const send=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{try{
    if(closed||!o.authorize())throw new AppError(403,'Environment task grant is closed');
    if(req.method!=='POST'||req.url!=='/environment')throw new AppError(404,'Not found');
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError(415,'Use application/json');
    let body='';req.setEncoding('utf8');for await(const part of req){body+=part;if(Buffer.byteLength(body)>65536)throw new AppError(413,'Environment request too large');}
    let input:any;try{input=JSON.parse(body);}catch{throw new AppError(400,'Invalid JSON');}
    if(!input||Array.isArray(input))throw new AppError(400,'Invalid environment request');
    requireId(input.requestId);const action=input.action??'execute';let invoke:()=>Promise<any>;let payload:unknown;
    if(action==='execute'){
      if(Object.keys(input).some(k=>!['requestId','action','command','timeoutMs'].includes(k))||typeof input.command!=='string'||!input.command.trim()||Buffer.byteLength(input.command)>60000)throw new AppError(400,'Command must be 1-60000 bytes');
      const timeout=input.timeoutMs??30000;if(!Number.isInteger(timeout)||timeout<100||timeout>90000)throw new AppError(400,'Timeout must be 100-90000 ms');
      payload=[action,input.command,timeout];invoke=()=>o.environment.execute(input.command,timeout);
    }else if(action==='packages'){
      if(!o.installPackages)throw new AppError(403,'Package installation is not enabled');
      if(Object.keys(input).some(k=>!['requestId','action','packages'].includes(k))||!Array.isArray(input.packages)||!input.packages.length||input.packages.length>16||!input.packages.every(validPackage))throw new AppError(400,'Provide 1-16 Debian package names');
      payload=[action,input.packages];invoke=async()=>({stdout:JSON.stringify(await o.installPackages!(input.packages,input.requestId)),stderr:'',code:0,timedOut:false,truncated:false});
    }else if(action==='fetch'){
      if(!o.fetchUrl)throw new AppError(403,'Governed HTTPS fetch is not enabled');
      if(Object.keys(input).some(k=>!['requestId','action','url'].includes(k))||typeof input.url!=='string'||input.url.length>4096)throw new AppError(400,'Invalid URL');
      payload=[action,input.url];invoke=async()=>({stdout:JSON.stringify(await o.fetchUrl!(input.url)),stderr:'',code:0,timedOut:false,truncated:false});
    }else throw new AppError(400,'Unsupported environment action');
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex'),previous=receipts.get(input.requestId);
    if(closed||!o.authorize())throw new AppError(403,'Environment task grant is closed');
    if(previous){if(previous.hash!==hash)throw new AppError(409,'Request ID reused with different command');if(previous.state!=='done')throw new AppError(409,'Command outcome uncertain or still pending; never replay automatically');send(res,200,previous.value);return;}
    if(!healthy)throw new AppError(409,'Environment outcome uncertain; task must stop before new work');if(receiptBytes>=2*1024*1024)throw new AppError(429,'Environment receipt budget reached');if(active)throw new AppError(409,'Another environment command is active');if(receipts.size>=1000)throw new AppError(429,'Task environment command limit reached');
    const receipt:{hash:string;state:'pending'|'done'|'uncertain';value?:unknown}={hash,state:'pending'};receipts.set(input.requestId,receipt);active=true;
    o.onEvent?.('environment.command.started',{requestId:input.requestId,action});
    try{pending=invoke();const result=await pending as Awaited<ReturnType<StableEnvironment['execute']>>;if(result.timedOut){healthy=false;throw new AppError(409,'Environment command timed out; task environment must stop');}if(closed||!o.authorize())throw new AppError(403,'Environment grant revoked before result');receipt.state='done';receipt.value=result;receiptBytes+=Buffer.byteLength(JSON.stringify(result));o.onEvent?.('environment.command.finished',{requestId:input.requestId,code:result.code,timedOut:result.timedOut,truncated:result.truncated});send(res,200,result);}
    catch(error){receipt.state='uncertain';healthy=false;throw error;}finally{active=false;pending=undefined;}
  }catch(error){if(!res.headersSent)send(res,error instanceof AppError?error.status:502,{error:error instanceof AppError?error.message:'Environment command failed; inspect state before a new command. Its effect may be unknown.'});else res.end();}};
  return {handler,close:async()=>{closed=true;await pending?.catch(()=>{});},isIdle:()=>!active,isHealthy:()=>healthy&&!active};
}
export async function startEnvironmentBroker(o:EnvironmentBrokerOptions){
  const handler=createEnvironmentHandler(o),server=createServer(handler.handler);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(o.socketPath,()=>resolve());});await chmod(o.socketPath,0o600);
  return {isIdle:handler.isIdle,isHealthy:handler.isHealthy,async close(){const drain=handler.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await drain;await unlink(o.socketPath).catch(error=>{if(error.code!=='ENOENT')throw error;});}};
}
