import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Scheduler, type ScheduleInput } from './schedules.ts';
import { EnvironmentPolicies } from './environments/policy.ts';
import { telegramReadiness } from './channels/telegram.ts';
import { Store } from './store.ts';
import { AppError } from './types.ts';
import { AuthManager, type OAuthFlow } from './auth.ts';
import { type Config } from './config.ts';
import { MemoryMaintenance } from './memory/maintenance.ts';
import { MemoryRepository, type SaveMemory, type UpdateMemory } from './memory/repository.ts';
const webRoot=fileURLToPath(new URL('../web/',import.meta.url));
function send(res:ServerResponse,status:number,data:unknown) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage) { if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError(415,'Use application/json'); req.setEncoding('utf8'); let text=''; for await(const chunk of req){text+=chunk; if(Buffer.byteLength(text)>65536)throw new AppError(413,'Request too large');} try {const parsed=JSON.parse(text); if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw 0; return parsed as Record<string,unknown>;}catch{throw new AppError(400,'Invalid JSON object');} }
export function createApi(store:Store,c:Config,dependencies:{oauthFlow?:OAuthFlow;authFetch?:typeof fetch}={}) {
  const scheduler=new Scheduler(store),policies=new EnvironmentPolicies(store);
  let auth:AuthManager|undefined;
  let memory: MemoryRepository | undefined;
  let maintenance: MemoryMaintenance | undefined;
  const server = createServer(async(req,res)=>{
    try {
      const host=req.headers.host ?? ''; const expectedPort=(res.socket?.localPort ?? c.port); const allowedHost=c.host==='::1'?`[::1]:${expectedPort}`:`${c.host}:${expectedPort}`;
      if(![allowedHost,`localhost:${expectedPort}`].includes(host))throw new AppError(403,'Invalid Host header');
      const url=new URL(req.url ?? '/',`http://${host}`);
      if(req.headers.origin && req.headers.origin!==`http://${host}`)throw new AppError(403,'Cross-origin requests are not allowed');
      if(req.method==='GET' && ['/','/index.html','/app.js','/styles.css'].includes(url.pathname)) {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1); const data=await readFile(join(webRoot,file));
        res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-cache','content-security-policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'x-content-type-options':'nosniff'});res.end(data);return;
      }
      if(['/api/auth','/api/auth/chatgpt','/api/auth/callback','/api/auth/models','/api/auth/model'].includes(url.pathname)){
        auth??=new AuthManager(join(c.root,'control','auth'),dependencies.oauthFlow,dependencies.authFetch);
        if(req.method==='GET'&&url.pathname==='/api/auth'){send(res,200,{...auth.status(),apiKeyConfigured:c.apiKeyConfigured??!!c.apiKey});return;}
        if(req.method==='GET'&&url.pathname==='/api/auth/models'){send(res,200,await auth.models());return;}
        const b=await body(req);
        if(req.method==='POST'&&url.pathname==='/api/auth/chatgpt'){send(res,202,await auth.startLogin(b.requestId as string));return;}
        if(req.method==='POST'&&url.pathname==='/api/auth/callback'){send(res,202,auth.submitCallback(b.id as string,b.url as string));return;}
        if(req.method==='POST'&&url.pathname==='/api/auth/model'){send(res,200,await auth.selectModel(b.model as string));return;}
        if(req.method==='DELETE'&&url.pathname==='/api/auth'){send(res,200,await auth.logout());return;}
        throw new AppError(405,'Method not allowed');
      }
      if(url.pathname==='/api/status' && req.method==='GET') {send(res,200,{mode:c.mode,sandboxProfile:c.sandboxProfile,experimental:c.sandboxProfile!=='ephemeral',worker:store.workerStatus(),concurrency:1,quarantines:store.quarantines(),isolation:c.mode==='demo'?'none (model-less; no shell or network)':'rootless Docker, network none',version:'0.2.0-dev',capabilities:{serviceProfile:c.sandboxProfile==='service',liveVerified:false,network:'none + governed HTTPS fetch',packageInstall:'operator allowlist'},channels:{telegram:telegramReadiness(store)}});return;}
      if(url.pathname==='/api/events' && req.method==='GET'){send(res,200,store.changes(cursor(url)));return;}
      if(url.pathname==='/api/bots') {
        if(req.method==='GET'){send(res,200,store.bots());return;}
        if(req.method==='POST'){const b=await body(req);send(res,201,store.createBot(b.name as string,b.requestId as string|undefined));return;}
      }
      const botReceipt=/^\/api\/bot-requests\/([^/]+)$/.exec(url.pathname);
      if(botReceipt&&req.method==='GET'){send(res,200,store.botReceipt(botReceipt[1]!));return;}
      const receipt=/^\/api\/bots\/([^/]+)\/requests\/([^/]+)$/.exec(url.pathname);
      if(receipt&&req.method==='GET'){send(res,200,store.requestStatus(receipt[1]!,receipt[2]!));return;}
      const envMatch=/^\/api\/bots\/([^/]+)\/environment$/.exec(url.pathname);
      if(envMatch&&req.method==='GET'){const botId=envMatch[1]!;send(res,200,{...(store.environment(botId)??{botId,profile:c.sandboxProfile,state:'unprovisioned'}),policy:policies.get(botId),stop:policies.stopStatus(botId),verification:'not-live-verified'});return;}
      const policyMatch=/^\/api\/bots\/([^/]+)\/environment\/(policy|stop|reconcile)$/.exec(url.pathname);
      if(policyMatch){const [,botId,action]=policyMatch;store.bot(botId!);const b=await body(req);
        if(action==='policy'&&req.method==='PUT'){send(res,200,policies.set(botId!,b as any));return;}
        if(action==='stop'&&req.method==='POST'){if(c.sandboxProfile!=='service')throw new AppError(409,'Environment stop requires service profile');
          const admitted=policies.requestStop(botId!,b.requestId as string);if(!admitted.replayed){const active=store.tasks(botId!).find(task=>['running','cancelling'].includes(task.state));if(active)store.command(botId!,active.id,b.requestId as string,'cancel');}send(res,202,admitted);return;}
        if(action==='reconcile'&&req.method==='POST'){const env=store.environment(botId!),q=store.quarantines().find(q=>q.botId===botId&&q.runId===b.runId);if(b.confirmed!==true||!env?.containerId||b.containerId!==env.containerId||!q?.reason.startsWith('Operator package reconciliation required:')||!policies.packageState(q.runId).length||policies.packageState(q.runId).some(item=>item.state!=='contained'))throw new AppError(409,'Confirm the reviewed run and exact current container identity');policies.reviewPackages(q.runId);store.noteQuarantine(q.runId,'Operator reviewed partial package changes; verify runner and environment stopped before release');send(res,202,{state:'awaiting_verified_stop'});return;}
        throw new AppError(405,'Method not allowed');
      }
      const schedulesMatch=/^\/api\/bots\/([^/]+)\/schedules(?:\/([^/]+)(?:\/(pause|resume|history))?)?$/.exec(url.pathname);
      if(schedulesMatch){const [,botId,id,action]=schedulesMatch;store.bot(botId!);
        if(!id&&req.method==='GET'){send(res,200,{schedules:scheduler.list(botId!),status:scheduler.status(botId!)});return;}
        if(!id&&req.method==='POST'){send(res,201,scheduler.create(botId!,await body(req) as ScheduleInput));return;}
        if(id&&action==='history'&&req.method==='GET'){send(res,200,scheduler.history(botId!,id));return;}
        if(id&&action==='pause'&&req.method==='POST'){await body(req);send(res,200,scheduler.pause(botId!,id));return;}
        if(id&&action==='resume'&&req.method==='POST'){await body(req);send(res,200,scheduler.resume(botId!,id));return;}
        if(id&&!action&&req.method==='DELETE'){await body(req);send(res,200,scheduler.delete(botId!,id));return;}
        throw new AppError(405,'Method not allowed');
      }
      const memoryMatch = /^\/api\/bots\/([^/]+)\/memory(?:\/([^/]+))?$/.exec(url.pathname);
      if (memoryMatch) {
        const [, botId, id] = memoryMatch; store.bot(botId!);
        memory ??= new MemoryRepository(join(c.root, 'control', 'memory'));
        if (id === 'maintenance') {
          maintenance ??= new MemoryMaintenance(store,c);
          if (req.method === 'GET') { send(res,200,{ job: maintenance.status(botId!), progress: memory.maintenanceState(botId!) }); return; }
          const b = await body(req);
          if (req.method === 'POST') { if (!memory.snapshot(botId!).enabled) throw new AppError(409,'Memory is turned off'); send(res,202,maintenance.requestDream(botId!,b.requestId as string)); return; }
          if (req.method === 'DELETE') { memory.dismissConflict(botId!,b.id as string,b.requestId as string); send(res,200,{ progress: memory.maintenanceState(botId!) }); return; }
          throw new AppError(405,'Method not allowed');
        }
        if (!id && req.method === 'GET') { const query = url.searchParams.get('q') ?? ''; if (query.length > 300) throw new AppError(400, 'Memory search is too long'); send(res, 200, memory.snapshot(botId!, query)); return; }
        if (['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
          const b = await body(req);
          if (b.sourceTaskId !== undefined) store.task(botId!, b.sourceTaskId as string);
          if (!id && req.method === 'POST') { const changed = memory.save(botId!, { requestId: b.requestId as string, title: b.title as string, content: b.content as string, scope: b.scope as SaveMemory['scope'], kind: b.kind as SaveMemory['kind'], ...(b.sourceTaskId ? { sourceTaskId: b.sourceTaskId as string } : {}) }); send(res, changed.replayed ? 200 : 201, changed); return; }
          if (id === 'settings' && req.method === 'PATCH') { send(res, 200, memory.settings(botId!, { requestId: b.requestId as string, expectedVersion: b.expectedVersion as string, project: b.project as string | null, enabled: b.enabled as boolean })); return; }
          if (id && req.method === 'PATCH') { send(res, 200, memory.update(botId!, id, { requestId: b.requestId as string, expectedRevision: b.expectedRevision as string, title: b.title as string, content: b.content as string, ...(b.sourceTaskId ? { sourceTaskId: b.sourceTaskId as string } : {}) } as UpdateMemory)); return; }
          if (id && req.method === 'DELETE') { send(res, 200, memory.forget(botId!, id, { requestId: b.requestId as string, expectedRevision: b.expectedRevision as string })); return; }
        }
      }
      const m=/^\/api\/bots\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(events|commands))?)?$/.exec(url.pathname);
      if(m){const [,botId,taskId,action]=m;
        if(!taskId && req.method==='GET'){send(res,200,store.tasks(botId!));return;}
        if(!taskId && req.method==='POST'){const b=await body(req);send(res,202,store.submit(botId!,b.messageId as string,b.prompt as string));return;}
        if(taskId && !action && req.method==='GET'){send(res,200,store.task(botId!,taskId));return;}
        if(taskId && action==='events' && req.method==='GET'){send(res,200,store.events(botId!,taskId,cursor(url)));return;}
        if(taskId && action==='commands' && req.method==='POST'){const b=await body(req);send(res,202,store.command(botId!,taskId,b.messageId as string,b.type as string,b.text as string|undefined));return;}
      }
      throw new AppError(404,'Not found');
    }catch(error){if(!res.headersSent)send(res,error instanceof AppError?error.status:500,{error:error instanceof AppError?error.message:'Internal error'});else res.end();}
  });
  server.on('close',()=>auth?.close());
  return server;
}
function cursor(url:URL){const n=Number(url.searchParams.get('after') ?? 0); if(!Number.isSafeInteger(n)||n<0)throw new AppError(400,'Invalid event cursor');return n;}
