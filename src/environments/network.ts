import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { validHost } from './policy.ts';
export function isPublicAddress(address:string):boolean{
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number) as [number,number,number,number];return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));}
  if(isIP(address)===6){const lower=new URL(`http://[${address}]/`).hostname.slice(1,-1).toLowerCase();return /^[23][0-9a-f]{3}:/.test(lower)&&!lower.startsWith('2001:db8:')&&!(lower.startsWith('2001:')&&parseInt(lower.split(':')[1]||'0',16)<0x200)&&!lower.startsWith('2002:')&&!lower.startsWith('3fff:');}return false;
}
export function checkedUrl(input:string,allowedHosts:readonly string[]):URL{
  if(typeof input!=='string'||input.length>4096)throw new Error('URL too long');const url=new URL(input);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!validHost(url.hostname)||!allowedHosts.includes(url.hostname))throw new Error('URL must use HTTPS and an exact operator-allowed DNS host');return url;
}
export interface NetworkFetchDependencies {timeoutMs?:number;resolve?:(host:string)=>Promise<{address:string;family:number}[]>;fetch?:(url:URL,address:{address:string;family:number},signal:AbortSignal)=>Promise<{status:number;contentType:string;body:string}>}
/** Exact-host HTTPS fetch only; DNS is checked then pinned. Redirects never follow implicitly. */
export async function governedFetch(input:string,allowedHosts:readonly string[],authorize:()=>boolean,deps:NetworkFetchDependencies={}){
  const url=checkedUrl(input,allowedHosts);if(!authorize())throw new Error('Network grant closed');
  const timeoutMs=deps.timeoutMs??15000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw new Error('Invalid network deadline');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const deadline=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('Governed network request deadline exceeded')),{once:true}));
  try{
    const addresses=await Promise.race([(deps.resolve??(host=>lookup(host,{all:true,verbatim:true})))(url.hostname),deadline]);
    if(!addresses.length||addresses.some(value=>isIP(value.address)!==value.family||!isPublicAddress(value.address)))throw new Error('Private, local, metadata or reserved network destination denied');
    if(!authorize()||controller.signal.aborted)throw new Error('Network grant closed');
    const value=await Promise.race([(deps.fetch??pinnedFetch)(url,addresses[0]!,controller.signal),deadline]);
    if(!authorize())throw new Error('Network grant revoked');if(value.status>=300&&value.status<400)throw new Error('Redirect refused; request the allowed target explicitly');
    if(!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.body!=='string'||typeof value.contentType!=='string')throw new Error('Invalid network response');
    const bytes=Buffer.from(value.body);return {...value,contentType:value.contentType.slice(0,200),body:bytes.subarray(0,12000).toString('utf8'),truncated:bytes.length>12000};
  }finally{clearTimeout(timer);}

}
async function pinnedFetch(url:URL,address:{address:string;family:number},signal:AbortSignal):Promise<{status:number;contentType:string;body:string}>{
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',agent:false,signal,rejectUnauthorized:true,servername:url.hostname,lookup:((_host:any,_options:any,callback:any)=>_options?.all?callback(null,[address]):callback(null,address.address,address.family)) as any,headers:{accept:'text/plain, text/html, application/json','user-agent':'Chestnut-Governed-Fetch/1'}},res=>{
      const chunks:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>128*1024){res.destroy(new Error('Network response exceeds 128 KiB'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode??502,contentType:String(res.headers['content-type']??''),body:Buffer.concat(chunks).toString('utf8')}));
    });req.on('error',reject);req.end();
  });
}
