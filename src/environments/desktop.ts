import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { AppError, requireId } from '../types.ts';
import type { StableEnvironment } from './stable-docker.ts';
export const DESKTOP_WIDTH=1280,DESKTOP_HEIGHT=800,DESKTOP_MAX_PNG=512000;
export type ComputerInput={op:'screenshot'|'click'|'type'|'key'|'navigate'|'windows'|'focus';x?:number;y?:number;button?:number;text?:string;key?:string;url?:string;window?:string};
export const DESKTOP_KEYS=['Return','Tab','Escape','BackSpace','Left','Right','Up','Down','Page_Up','Page_Down','Home','End','ctrl+l','ctrl+r','ctrl+t','ctrl+w','alt+Left','alt+Right'];
export function computerInput(value:any):ComputerInput{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(400,'Invalid computer action');
  const keys:Record<string,string[]>={screenshot:[],windows:[],click:['x','y','button'],type:['text'],key:['key'],navigate:['url'],focus:['window']};
  if(!Object.hasOwn(keys,value.op)||Object.keys(value).some(k=>k!=='op'&&!keys[value.op]!.includes(k)))throw new AppError(400,'Unsupported computer action fields');
  if(value.op==='click'&&(!Number.isInteger(value.x)||value.x<0||value.x>=DESKTOP_WIDTH||!Number.isInteger(value.y)||value.y<0||value.y>=DESKTOP_HEIGHT||![1,2,3].includes(value.button??1)))throw new AppError(400,'Click must be inside the Bot screen');
  if(value.op==='type'&&(typeof value.text!=='string'||value.text.length>2000||value.text.includes('\0')))throw new AppError(400,'Type at most 2000 characters');
  if(value.op==='key'&&!DESKTOP_KEYS.includes(value.key))throw new AppError(400,'Unsupported key');
  if(value.op==='navigate'&&!['about:blank','http://127.0.0.1:8787/','chrome://sandbox/'].includes(value.url))throw new AppError(403,'Desktop is offline: only the local fixture or about:blank is allowed');
  if(value.op==='focus'&&(typeof value.window!=='string'||!/^\d{1,10}$/.test(value.window)))throw new AppError(400,'Invalid Bot window ID');
  return value;
}
export function desktopFrame(value:any){
  if(typeof value?.png!=='string'||value.png.length>Math.ceil(DESKTOP_MAX_PNG/3)*4||!value.png.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.png))throw new Error('Invalid desktop frame');
  const bytes=Buffer.from(value.png,'base64');if(bytes.length<24||bytes.length>DESKTOP_MAX_PNG||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==DESKTOP_WIDTH||bytes.readUInt32BE(20)!==DESKTOP_HEIGHT)throw new Error('Invalid desktop PNG dimensions');
  return {png:value.png,width:DESKTOP_WIDTH,height:DESKTOP_HEIGHT};
}
export class BotDesktop {
  private tail:Promise<unknown>=Promise.resolve();
  readonly store:Store;readonly botId:string;readonly environment:StableEnvironment;readonly authorize:()=>boolean;
  constructor(store:Store,botId:string,environment:StableEnvironment,authorize:()=>boolean){this.store=store;this.botId=botId;this.environment=environment;this.authorize=authorize;}
  private fence(){if(!this.authorize())throw new Error('Desktop grant closed');}
  perform(input:ComputerInput){computerInput(input);this.fence();const result=this.tail.then(()=>this.performSerial(input));this.tail=result.catch(()=>{});return result;}
  private async performSerial(input:ComputerInput){
    this.fence();
      await this.environment.ensureRunning();this.fence();const previous=this.store.get<any>('SELECT * FROM desktop_sessions WHERE botId=?',this.botId);
      const sessionId=previous?.state==='running'?previous.sessionId:randomUUID(),url=input.op==='navigate'?input.url:previous?.url??'http://127.0.0.1:8787/';
      const value=JSON.parse(await this.environment.desktopCommand(DESKTOP_WRAPPER,{...input,url,sessionId}));this.fence();
      requireId(value.sessionId);const activeSessionId=value.sessionId;const frame=desktopFrame(value);const windows=Array.isArray(value.windows)?value.windows.slice(0,16).filter((w:any)=>/^\d{1,10}$/.test(w.id)&&typeof w.title==='string').map((w:any)=>({id:w.id,title:w.title.slice(0,200)})):[];
      this.store.db.prepare("INSERT INTO desktop_sessions VALUES(?,?,'running',?,?,?,NULL) ON CONFLICT(botId) DO UPDATE SET sessionId=excluded.sessionId,state='running',url=excluded.url,capturedAt=excluded.capturedAt,png=excluded.png,error=NULL").run(this.botId,activeSessionId,url,Date.now(),frame.png);
      return {botId:this.botId,sessionId:activeSessionId,url,capturedAt:Date.now(),...frame,windows,untrusted:true};
  }
}

// Trusted argv wrapper, never loaded from the writable guest. Runs as UID 1000.
// Display, browser profile, lock files and fixture process live only in /tmp tmpfs.
function guestDesktop(){
  const fs=require('node:fs'),cp=require('node:child_process');
  const input=JSON.parse(process.argv[1]),root='/tmp/chestnut-desktop';fs.mkdirSync(root,{recursive:true,mode:0o700});
  const env={...process.env,DISPLAY:':99',HOME:root,XDG_RUNTIME_DIR:root};
  const exec=(name:string,args:string[])=>cp.execFileSync(name,args,{env,timeout:8000,maxBuffer:512000});
  const start=(name:string,args:string[])=>{const fd=fs.openSync(root+'/log','a',0o600);const child=cp.spawn(name,args,{env,stdio:['ignore',fd,fd],detached:true});child.unref();fs.closeSync(fd);};
  const sleep=(ms:number)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
  const alive=(name:string)=>{try{exec('/usr/bin/pgrep',['-u','1000','-x',name]);return true;}catch{return false;}};
  if(!alive('Xvfb')){start('/usr/bin/Xvfb',[':99','-screen','0','1280x800x24','-nolisten','tcp']);for(let i=0;i<30;i++){try{exec('/usr/bin/xdotool',['getmouselocation']);break;}catch{sleep(100);}}}
  if(!alive('openbox'))start('/usr/bin/openbox',[]);
  // This fixture never requests external resources, returns credentials, or exposes a host port.
  if(!fs.existsSync(root+'/fixture.pid')){
    const html="<!doctype html><title>Chestnut offline fixture</title><h1>Bot-local browser fixture</h1><label>Name <input id=name></label><button id=go onclick=\"document.getElementById('result').textContent='Hello '+document.getElementById('name').value\">Greet</button><p id=result>Ready</p>";
    const program=`const http=require('node:http'),fs=require('node:fs');const html=${JSON.stringify(html)};const s=http.createServer((q,r)=>{if(!['/','http://127.0.0.1:8787/'].includes(q.url)){r.writeHead(403);r.end('Offline fixture only');return;}r.writeHead(200,{'content-type':'text/html','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"});r.end(html)});for(const event of ['connect','upgrade'])s.on(event,(_q,socket)=>socket.end('HTTP/1.1 403 Forbidden'+String.fromCharCode(13,10)+'Content-Length: 0'+String.fromCharCode(13,10,13,10)));s.listen(8787,'127.0.0.1',()=>fs.writeFileSync('/tmp/chestnut-desktop/fixture.pid',String(process.pid)))`;

    start(process.execPath,['-e',program]);sleep(200);
  }
  if(!alive('chromium'))start('/usr/bin/chromium',['--user-data-dir='+root+'/profile','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-quic','--disable-dev-shm-usage','--proxy-server=http://127.0.0.1:8787','--proxy-bypass-list=<-loopback>',input.url]);
  const sessionPath=root+'/session',sessionId=fs.existsSync(sessionPath)?fs.readFileSync(sessionPath,'utf8'):require('node:crypto').randomUUID();fs.writeFileSync(sessionPath,sessionId,{mode:0o600});
  const visible=()=>exec('/usr/bin/xdotool',['search','--onlyvisible','--class','chromium']).toString().trim().split('\n').filter((s:string)=>/^\d+$/.test(s)).slice(0,16);
  let ids:string[]=[];for(let i=0;i<40&&!ids.length;i++){try{ids=visible();}catch{}if(!ids.length)sleep(100);}
  if(!ids.length)throw new Error('Sandboxed browser did not become ready; no sandbox fallback is permitted');
  if(input.op==='focus'&&!ids.includes(input.window))throw new Error('Window is not owned by this Bot browser');
  exec('/usr/bin/xdotool',['windowactivate','--sync',input.op==='focus'?input.window:ids[0]]);
  if(input.op==='click')exec('/usr/bin/xdotool',['mousemove',String(input.x),String(input.y),'click',String(input.button??1)]);
  if(input.op==='type')exec('/usr/bin/xdotool',['type','--clearmodifiers','--delay','0','--',input.text]);
  if(input.op==='key')exec('/usr/bin/xdotool',['key','--clearmodifiers',input.key]);
  if(input.op==='navigate'){exec('/usr/bin/xdotool',['key','--clearmodifiers','ctrl+l']);exec('/usr/bin/xdotool',['type','--clearmodifiers','--delay','0','--',input.url]);exec('/usr/bin/xdotool',['key','Return']);}
  sleep(200);
  const png=exec('/usr/bin/import',['-display',':99','-window','root','-depth','8','png:-']);
  const windows=ids.map(id=>({id,title:exec('/usr/bin/xdotool',['getwindowname',id]).toString().slice(0,200)}));
  process.stdout.write(JSON.stringify({png:png.toString('base64'),windows,sessionId}));
}
// Node 24 erases the annotations before function.toString(); validate this source
// in the offline suite before any container execution.
export const DESKTOP_WRAPPER=`(${guestDesktop.toString()})();`;
