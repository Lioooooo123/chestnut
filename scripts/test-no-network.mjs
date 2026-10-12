// Default test runs may use local fixtures, never live external endpoints or ambient credentials.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const local=host=>['localhost','127.0.0.1','::1','[::1]',''].includes(String(host??''));
const deny=()=>{throw new Error('External network is disabled in the default test suite; inject a transport fixture.');};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(!local(url.hostname))return Promise.reject(new Error('External fetch is disabled in the default test suite; inject a fetch fixture.'));return originalFetch(input,init);};
for(const module of [http,https])for(const name of ['request','get']){const original=module[name];module[name]=function(...args){const first=args[0];let host;if(typeof first==='string'||first instanceof URL)host=new URL(first).hostname;else host=first?.hostname??first?.host;if(!first?.socketPath&&!local(host))deny();return original.apply(this,args);};}
const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let options=args[0];if(Array.isArray(options))options=options[0];if(options&&typeof options==='object'){if(!options.path&&!local(options.host))deny();}else if(typeof options==='number'){if(typeof args[1]==='string'&&!local(args[1]))deny();}else if(typeof options==='string'&&!options.startsWith('/'))deny();return originalConnect.apply(this,args);};
syncBuiltinESMExports();
