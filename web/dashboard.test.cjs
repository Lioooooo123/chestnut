/** Socket-free controller tests. These do not replace real-browser visual QA.
 * Run: node --test web/dashboard.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, children: [], _text: '', value: '', hidden: false, disabled: false, readOnly: false, dataset: {}, className: '', attributes: {}, listeners: {}, scrollHeight: 100, scrollTop: 0, clientHeight: 100 }); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent || '').join(''); }
  set innerHTML(_value) { throw new Error('Unsafe HTML rendering is not allowed.'); }
  get classList() { return { toggle: (name, yes) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (yes) set.add(name); else set.delete(name); this.className = [...set].join(' '); } }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async emit(type) { await Promise.all((this.listeners[type] || []).map((fn) => fn({ preventDefault() {}, key: '', target: this }))); }
  querySelectorAll(selector) { const children = this.children.flatMap((node) => [node, ...node.querySelectorAll('*')]); return selector === 'details[open]' ? children.filter((node) => node.tag === 'details' && node.open) : children; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
async function setup(existing = {}) {
  const elements = new Map();
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Node(match[1]); node.hidden = match[0].includes(' hidden'); elements.set(match[2], node);
  }
  elements.get('steer-tab').dataset.command = 'steer'; elements.get('follow-up-tab').dataset.command = 'follow_up';
  const document = new Node('document');
  document.hidden = false; document.getElementById = (id) => { assert.ok(elements.has(id), `Missing element ${id}`); return elements.get(id); };
  document.createElement = (tag) => new Node(tag);
  document.querySelectorAll = (selector) => selector === '[data-command]' ? [elements.get('steer-tab'), elements.get('follow-up-tab')] : [];
  const backend = existing.backend || { environments: new Map(), schedules: [], fires: [], auth: {connected:false,preferred:false,model:null,login:null,apiKeyConfigured:false}, authModels:[{id:'account-model',name:'Account model'}], bots: [], tasks: [], events: [], memories: [], maintenance: { job: {state:'succeeded',provider:'explicit-demo',automatic:true}, progress: {cursor:7,lastDreamAt:Date.now(),conflicts:[]} }, memoryVersion: 'a'.repeat(40), memoryEnabled: true, memoryProject: null, status: { mode: 'demo', capabilities: {serviceProfile:false,liveVerified:false,network:'none + governed HTTPS fetch',packageInstall:'operator allowlist'}, channels:{telegram:{enabled:false,configured:false,mode:'private-long-poll',botId:null,online:false,status:'disabled',lastSeen:null,lastError:null,deliveries:{}}}, worker: { online: true }, quarantines: [] }, calls: [], failNextTask: false, failNetwork: false };
  backend.requests ||= new Map(); backend.botRequests ||= new Map();
  const session = existing.session || new Map(), local = existing.local || new Map();
  const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(payload) });
  const task = (botId, prompt) => { const result = { id: webcrypto.randomUUID(), botId, prompt, state: 'queued', result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() }; backend.tasks.unshift(result); return result; };
  const fetch = async (url, options = {}) => {
    const pathname = url.split('?')[0]; const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : undefined;
    backend.calls.push({ pathname, url, method, body });
    const authReply=pathname==='/api/auth'&&method==='GET'?structuredClone(backend.auth):null;
    const environmentMatch = pathname.match(/^\/api\/bots\/([^/]+)\/environment(?:\/(policy|stop))?$/);
    const scheduleMatch = pathname.match(/^\/api\/bots\/([^/]+)\/schedules(?:\/([^/]+)(?:\/(pause|resume|history))?)?$/);
    let environmentReply, scheduleReply;
    if (environmentMatch) {
      const botId = environmentMatch[1];
      if (!backend.environments.has(botId)) backend.environments.set(botId, {botId,profile:'service',state:'running',containerName:`chestnut-env-${botId}`,updatedAt:Date.now(),policy:{botId,revision:'none',allowedPackages:[],allowedHosts:[],updatedAt:0},stop:null,verification:'not-live-verified'});
      environmentReply = structuredClone(backend.environments.get(botId));
    }
    if (scheduleMatch && method === 'GET') scheduleReply = scheduleMatch[3] === 'history' ? backend.fires.filter(fire => fire.scheduleId === scheduleMatch[2]) : {schedules:backend.schedules.filter(schedule => schedule.botId === scheduleMatch[1] && schedule.state !== 'deleted'),status:{}};
    scheduleReply = structuredClone(scheduleReply);
    if (backend.beforeFetch) await backend.beforeFetch({ pathname, method, signal:options.signal, body });
    if (backend.failNetwork) throw new TypeError('offline');
    if (pathname === '/api/auth' && method === 'GET') return response(authReply);
    if (pathname === '/api/auth' && method === 'DELETE') { backend.auth.connected=false;backend.auth.login=null;return response(backend.auth); }
    if (pathname === '/api/auth/chatgpt') { backend.auth.login={id:body.requestId,state:'awaiting',url:'https://auth.openai.com/api/accounts/authorize?state=test'};return response(backend.auth); }
    if (pathname === '/api/auth/models') return response(backend.authModels);
    if (pathname === '/api/auth/model') { backend.auth.model=body.model;return response(backend.auth); }
    if (pathname === '/api/auth/callback') return response(backend.auth);
    if (pathname === '/api/status') return response(backend.status);
    if (pathname === '/api/bots' && method === 'GET') return response(backend.bots);
    if (pathname.startsWith('/api/bot-requests/')) return backend.botRequests.has(pathname.split('/').at(-1)) ? response(backend.botRequests.get(pathname.split('/').at(-1))) : response({error:'Not found'},404);
    const receipt = pathname.match(/^\/api\/bots\/([^/]+)\/requests\/([^/]+)$/);
    if (receipt) { const stored=backend.requests.get(`${receipt[1]}:${receipt[2]}`);return stored?response(stored):response({error:'Not found'},404); }
    if (pathname === '/api/bots' && method === 'POST') { if(backend.failNextBot){backend.failNextBot=false;return response({error:'Bot not confirmed'},503);}const old=backend.botRequests.get(body.requestId);if(old)return old.name===body.name?response(old):response({error:'Different name'},409);const bot = { id: webcrypto.randomUUID(), name: body.name, createdAt: Date.now() }; backend.bots.push(bot);backend.botRequests.set(body.requestId,bot);if(backend.dropBotAck){backend.dropBotAck=false;throw new TypeError('Lost bot reply');}return response(bot); }
    if (environmentMatch) {
      const [, botId, action] = environmentMatch, environment = backend.environments.get(botId);
      if (method === 'GET') { if (backend.failEnvironment) return response({error:'Environment unavailable'},503); return response(environmentReply); }
      if (action === 'policy') { if (backend.failPolicy || body.expectedRevision !== environment.policy.revision) return response({error:'Environment policy changed; reload before editing'},409); environment.policy = {...body,botId,revision:webcrypto.randomUUID(),updatedAt:Date.now()}; return response(environment.policy); }
      if (action === 'stop') { if (backend.failStop) return response({error:'Stop not confirmed'},503); environment.stop = {state:'pending',error:null}; return response(environment.stop,202); }
    }
    if (scheduleMatch) {
      const [,botId,id,action] = scheduleMatch;
      if (method === 'GET') { if (backend.failSchedules) return response({error:'Schedule registry unavailable'},503); return response(scheduleReply); }
      if (!id) { if (backend.failCreateSchedule) return response({error:'Creation not confirmed'},503); const existing = backend.schedules.find(schedule => schedule.requestId === body.requestId); if(existing)return response(existing); const schedule = {...body,botId,id:webcrypto.randomUUID(),state:'active',nextRunAt:body.runAt||Date.now()+3600000,lastFireAt:null,lastTaskId:null,createdAt:Date.now(),updatedAt:Date.now()}; backend.schedules.push(schedule); return response(schedule,201); }
      if (backend.failScheduleChange) return response({error:'Schedule change not confirmed'},503);
      const schedule = backend.schedules.find(schedule => schedule.id === id && schedule.botId === botId); assert.ok(schedule);
      schedule.state = method === 'DELETE' ? 'deleted' : action === 'pause' ? 'paused' : 'active'; return response(schedule);
    }
    const memory = pathname.match(/^\/api\/bots\/([^/]+)\/memory(?:\/([^/]+))?$/);
    if (memory) {
      const [, botId, id] = memory;
      if (id === 'maintenance') {
        if (method === 'GET') return response(backend.maintenance);
        if (method === 'POST') { if (backend.failMaintenance) return response({error:'Worker maintenance queue unavailable.'},503); backend.maintenance.job.requested = body.requestId; return response(backend.maintenance.job); }
        if (method === 'DELETE') { backend.maintenance.progress.conflicts = backend.maintenance.progress.conflicts.filter(c => c.id !== body.id); return response(backend.maintenance); }
      }
      if (method === 'GET') return response({ version: backend.memoryVersion, enabled: backend.memoryEnabled, project: backend.memoryProject, writable: true, entries: backend.memories.filter(note => note.scope === 'personal' || note.botId === botId), history: [] });
      if (id === 'settings') { backend.memoryEnabled = body.enabled; backend.memoryProject = body.project; return response({}); }
      if (backend.failMemory) return response({ error: 'Memory changed. Read the latest revision before editing.' }, 409);
      backend.memoryVersion = 'b'.repeat(40);
      if (method === 'DELETE') { backend.memories = backend.memories.filter(note => note.id !== id); return response({ id, forgotten: true }); }
      const existing = backend.memories.find(note => note.id === id);
      const entry = { ...(existing || {}), id: id || body.requestId, botId: body.scope === 'personal' ? null : botId, source: 'user', revision: webcrypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...body };
      backend.memories = [...backend.memories.filter(note => note.id !== entry.id), entry]; return response({ id: entry.id, entry, version: backend.memoryVersion });
    }
    const match = pathname.match(/^\/api\/bots\/([^/]+)\/tasks(?:\/([^/]+)\/(events|commands))?$/); assert.ok(match, `Unknown request ${url}`);
    const [, botId, taskId, action] = match;
    if (action === 'events') return response(backend.events.filter((event) => event.taskId === taskId && event.seq > Number(url.split('after=')[1] || 0)));
    if (action === 'commands') {
      if (backend.failNextCommand) { backend.failNextCommand = false; return response({ error: 'Command not confirmed.' }, 503); }
      const receiptKey=`${botId}:${body.messageId}`;const old=backend.requests.get(receiptKey);if(old)return response(old.response);
      const result=body.type==='follow_up'?task(botId,body.text):{id:webcrypto.randomUUID(),...body};
      if (body.type === 'cancel') backend.tasks.find((entry) => entry.id === taskId).state = 'cancelling';
      backend.requests.set(receiptKey,{payload:{kind:'command',taskId,type:body.type,text:body.text??null},response:result});
      if(backend.dropCommandAck){backend.dropCommandAck=false;throw new TypeError('Lost command reply');}return response(result);
    }
    if (method === 'GET') return response(backend.tasks.filter((entry) => entry.botId === botId));
    if (backend.failNextTask) { backend.failNextTask = false; return response({ error: 'Try again later.' }, 503); }
    const receiptKey=`${botId}:${body.messageId}`;const old=backend.requests.get(receiptKey);if(old)return response(old.response);
    const result=task(botId,body.prompt);backend.requests.set(receiptKey,{payload:{kind:'task',prompt:body.prompt},response:result});
    if(backend.dropTaskAck){backend.dropTaskAck=false;throw new TypeError('Lost task reply');}return response(result);
  };
  const timers = new Map(); let nextTimer = 0;
  const context = vm.createContext({ document, window: new Node('window'), navigator: { clipboard: { writeText: async () => {} } }, URL, localStorage: { getItem: key => local.get(key) || null, setItem: (key,value) => local.set(key,value) }, sessionStorage: {getItem:key=>session.get(key)||null,setItem:(key,value)=>session.set(key,value)}, crypto: webcrypto, fetch, AbortController, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id), console, TypeError });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
  const run = (source) => vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
  await flush();
  const el = (id) => elements.get(id);
  const createBot = async (name = 'Research companion') => { el('bot-name').value = name; await el('bot-form').emit('submit'); await flush(); return backend.bots.at(-1); };
  const submit = async (prompt = 'A thoughtful test task.') => { el('task-prompt').value = prompt; await el('task-form').emit('submit'); await flush(); return backend.tasks.at(0); };
  return { run, flush, el, backend, createBot, submit, document, timers, session, local };
}

test('empty workspace and create/select bot', async () => {
  const s = await setup(); assert.equal(s.el('onboarding').hidden, false);
  const bot = await s.createBot(); assert.equal(s.el('workspace-title').textContent, bot.name);
  assert.equal(s.el('bot-workspace').hidden, false); assert.equal(s.el('onboarding').hidden, true);
  assert.match(s.el('mode-description').textContent, /No real AI calls or agent shell commands/);
});
test('repeated task submit sends once and includes a UUID', async () => {
  const s = await setup(); await s.createBot(); s.el('task-prompt').value = 'Do this once.';
  await Promise.all([s.el('task-form').emit('submit'), s.el('task-form').emit('submit')]); await s.flush();
  const posts = s.backend.calls.filter((call) => call.pathname.endsWith('/tasks') && call.method === 'POST');
  assert.equal(posts.length, 1); assert.match(posts[0].body.messageId, /^[0-9a-f-]{36}$/); assert.equal(s.el('task-prompt').value, '');
});
test('failed submission preserves draft and retry reuses message ID', async () => {
  const s = await setup(); await s.createBot(); s.backend.failNextTask = true;
  await s.submit('Keep this draft.'); assert.equal(s.el('task-prompt').value, 'Keep this draft.'); assert.equal(s.el('task-form-error').hidden, false);
  await s.submit('Keep this draft.');
  const posts = s.backend.calls.filter((call) => call.pathname.endsWith('/tasks') && call.method === 'POST');
  assert.equal(posts[0].body.messageId, posts[1].body.messageId); assert.equal(s.backend.tasks.length, 1);
});
test('changing the draft after a failed send generates a new message ID', async () => {
  const s = await setup(); await s.createBot(); s.backend.failNextTask = true;
  await s.submit('First draft.'); await s.submit('A changed draft.');
  const posts = s.backend.calls.filter((call) => call.pathname.endsWith('/tasks') && call.method === 'POST');
  assert.notEqual(posts[0].body.messageId, posts[1].body.messageId);
});
test('steer is running-only and follow-up creates a new task', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit();
  assert.equal(s.el('steer-tab').disabled, true); task.state = 'running'; await s.run('refresh()'); await s.flush();
  assert.equal(s.el('steer-tab').disabled, false); s.el('command-text').value = 'Focus on clarity.';
  await s.run("sendCommand('steer')"); await s.flush(); assert.equal(s.backend.tasks.length, 1);
  s.el('command-text').value = 'Take the next step.'; await s.run("sendCommand('follow_up')"); await s.flush();
  assert.equal(s.backend.tasks.length, 2); assert.equal(s.el('detail-prompt').textContent, 'Take the next step.');
});
test('cancellation stays pending until backend confirms; terminal follow-up is disabled', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit();
  await s.run("sendCommand('cancel')"); await s.flush();
  assert.equal(s.el('detail-state').textContent, 'Cancelling'); assert.equal(s.el('cancel-task').disabled, true);
  for (const terminal of ['cancelled', 'interrupted']) {
    task.state = terminal; await s.run('refresh()'); await s.flush();
    assert.equal(s.el('cancel-task').hidden, true); assert.equal(s.el('follow-up-tab').disabled, true);
    s.el('command-text').value = 'Do not send'; await s.run("sendCommand('follow_up')"); assert.equal(s.backend.tasks.length, 1);
  }
});
test('events are incremental, ordered, and do not imply completion', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit(); task.state = 'running';
  s.backend.events.push({ seq: 1, taskId: task.id, type: 'task.running', data: { text: '<script>unsafe</script>' }, createdAt: Date.now() }); await s.run('refresh()'); await s.flush();
  s.backend.events.push({ seq: 2, taskId: task.id, type: 'assistant.message', data: { text: 'A partial result.' }, createdAt: Date.now() }); await s.run('refresh()'); await s.flush();
  assert.equal(s.el('event-count').textContent, '2 events'); assert.equal(s.el('detail-state').textContent, 'Running');
  assert.equal(s.backend.calls.filter((call) => call.pathname.endsWith('/events')).at(-1).url.endsWith('after=1'), true);
  assert.match(s.el('event-log').textContent, /<script>unsafe<\/script>/);
});
test('errors and untrusted task names use plain text; draft survives navigation', async () => {
  const s = await setup(); const first = await s.createBot('<img src=x onerror=alert(1)>');
  assert.equal(s.el('workspace-title').textContent, first.name);
  s.el('task-prompt').value = 'An unfinished thought.'; const second = await s.createBot('Second bot');
  assert.equal(s.el('task-prompt').value, ''); s.run(`selectBot(${JSON.stringify(first.id)})`); await s.flush();
  assert.equal(s.el('task-prompt').value, 'An unfinished thought.');
  const task = await s.submit(); task.state = 'failed'; task.error = 'Sandbox unavailable.'; await s.run('refresh()'); await s.flush();
  assert.equal(s.el('result-label').textContent, 'Error'); assert.equal(s.el('task-result').textContent, task.error);
  assert.notEqual(first.id, second.id);
});
test('quarantine and offline-worker states are visible without false completion', async () => {
  const s = await setup(); await s.createBot(); await s.submit();
  s.backend.status.worker.online = false; s.backend.status.quarantines = [{ taskId: '12345678-abcd', reason: 'Container cleanup failed.' }]; await s.run('refresh()'); await s.flush();
  assert.equal(s.el('quarantine-banner').hidden, false); assert.match(s.el('quarantine-description').textContent, /Container cleanup failed/);
  assert.match(s.el('task-state-note').textContent, /until a worker connects/); assert.equal(s.el('detail-state').textContent, 'Queued');
});
test('network failure keeps existing history and offers retry', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit(); s.backend.failNetwork = true; await s.run('refresh()'); await s.flush();
  assert.equal(s.el('connection-error').hidden, false); assert.equal(s.el('detail-prompt').textContent, task.prompt);
  s.backend.failNetwork = false; await s.run('refresh()'); await s.flush(); assert.equal(s.el('connection-error').hidden, true);
});
test('hidden pages do not schedule polling; visibility resumes it', async () => {
  const s = await setup(); s.document.hidden = true; await s.document.emit('visibilitychange');
  assert.equal([...s.timers.values()].some((timer) => timer.delay === 2000), false);
  s.document.hidden = false; await s.document.emit('visibilitychange'); await s.flush();
  assert.equal([...s.timers.values()].some((timer) => timer.delay === 2000), true);
});

test('failed commands preserve text and reuse the message ID on retry', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit(); task.state = 'running'; await s.run('refresh()'); await s.flush();
  s.backend.failNextCommand = true; s.el('command-text').value = 'A careful direction.'; await s.run("sendCommand('steer')"); await s.flush();
  assert.equal(s.el('command-text').value, 'A careful direction.'); assert.equal(s.el('command-error').hidden, false);
  await s.run("sendCommand('steer')"); await s.flush();
  const calls = s.backend.calls.filter((call) => call.pathname.endsWith('/commands'));
  assert.equal(calls[0].body.messageId, calls[1].body.messageId); assert.equal(s.el('command-text').value, '');
});
test('a stale task response cannot overwrite a newer bot selection', async () => {
  const s = await setup(); const first = await s.createBot('First'); await s.submit('First task');
  const second = await s.createBot('Second'); await s.submit('Second task');
  s.run(`selectBot(${JSON.stringify(first.id)})`); await s.flush();
  let release; let waiting = false; const gate = new Promise((resolve) => { release = resolve; });
  s.backend.beforeFetch = async ({ pathname, method }) => { if (pathname === `/api/bots/${first.id}/tasks` && method === 'GET') { waiting = true; await gate; } };
  const refresh = s.run('refresh()');
  for (let i = 0; i < 200 && !waiting; i++) await Promise.resolve();
  assert.equal(waiting, true);
  s.run(`selectBot(${JSON.stringify(second.id)})`); release(); await refresh; await s.flush();
  assert.equal(s.el('workspace-title').textContent, 'Second'); assert.equal(s.el('detail-prompt').textContent, 'Second task');
});

test('memory editor saves safely, keeps a conflicting draft, and forget waits for confirmation', async () => {
  const s = await setup(); await s.createBot();
  await s.el('memory-tab').emit('click'); await s.flush();
  s.el('memory-title').value = 'Reply style'; s.el('memory-content').value = '<script>Use concise Chinese paragraphs.</script>';
  s.el('memory-scope').value = 'personal'; s.el('memory-kind').value = 'preference';
  await s.el('memory-form').emit('submit'); await s.flush();
  assert.equal(s.backend.memories.length, 1);
  assert.match(s.el('memory-list').textContent, /Reply style/);
  const note = s.backend.memories[0]; await s.run(`selectMemory(${JSON.stringify(note.id)})`);
  s.el('memory-content').value = 'A correction I must not lose.'; s.backend.failMemory = true;
  await s.el('memory-form').emit('submit'); await s.flush();
  assert.equal(s.el('memory-content').value, 'A correction I must not lose.');
  assert.match(s.el('memory-error').textContent, /changed/);
  s.backend.failMemory = false;
  await s.el('memory-forget').emit('click'); assert.equal(s.backend.memories.length, 1);
  assert.equal(s.el('memory-forget-confirm').hidden, false);
  await s.el('memory-forget-confirm').emit('click'); await s.flush();
  assert.equal(s.backend.memories.length, 0);
});

test('a settings draft keeps the version it was read from when another session changes memory', async () => {
  const s = await setup(); await s.createBot(); await s.el('memory-tab').emit('click'); await s.flush();
  s.document.activeElement = s.el('memory-project'); s.el('memory-project').value = 'chestnut';
  await s.el('memory-project').emit('input'); s.document.activeElement = s.el('memory-title');
  s.backend.memoryVersion = 'b'.repeat(40); await s.run('refresh()'); await s.flush();
  assert.equal(s.el('memory-project').value, 'chestnut');
  await s.el('memory-settings').emit('submit'); await s.flush();
  const saved = s.backend.calls.find(call => call.pathname.endsWith('/memory/settings'));
  assert.equal(saved.body.expectedVersion, 'a'.repeat(40));
});

test('Dreaming status and proposals are visible, requests deduplicate and dismiss never edits preferences', async () => {
  const s = await setup(); await s.createBot();
  s.backend.maintenance.progress.conflicts = [{id:webcrypto.randomUUID(),title:'Package manager',content:'<script>Prefer bun?</script>',sourceTaskId:webcrypto.randomUUID()}];
  await s.el('memory-tab').emit('click'); await s.flush();
  assert.match(s.el('memory-maintenance-status').textContent,/succeeded/);
  assert.match(s.el('memory-conflicts').textContent,/<script>Prefer bun/);
  await Promise.all([s.el('memory-dream').emit('click'),s.el('memory-dream').emit('click')]); await s.flush();
  assert.equal(s.backend.calls.filter(c => c.pathname.endsWith('/maintenance') && c.method === 'POST').length,1);
  assert.equal(s.el('memory-dream').disabled,true);
  const buttons = s.el('memory-conflicts').querySelectorAll('*').filter(n => n.tag === 'button');
  await buttons.find(b => b.textContent === 'Dismiss').emit('click'); await s.flush();
  assert.equal(s.backend.maintenance.progress.conflicts.length,0); assert.equal(s.backend.memories.length,0);
});

test('a failed Dreaming request stays visible and retry keeps the request ID', async () => {
  const s = await setup(); await s.createBot(); await s.el('memory-tab').emit('click'); await s.flush();
  s.backend.failMaintenance = true; await s.el('memory-dream').emit('click'); await s.flush();
  assert.equal(s.el('memory-maintenance-error').hidden,false); assert.match(s.el('memory-maintenance-error').textContent,/unavailable/);
  s.backend.failMaintenance = false; await s.el('memory-dream').emit('click'); await s.flush();
  const calls = s.backend.calls.filter(c => c.pathname.endsWith('/maintenance') && c.method === 'POST'); assert.equal(calls[0].body.requestId,calls[1].body.requestId);
});

test('ChatGPT connection presents the official sign-in link and account models without credential inputs',async()=>{
 const s=await setup();s.backend.status.mode='pi';await s.run('refresh()');await s.flush();await s.el('auth-connect').emit('click');await s.flush();assert.equal(s.el('auth-link').href,'https://auth.openai.com/api/accounts/authorize?state=test');assert.equal(s.el('auth-link').hidden,false);
 s.backend.auth={...s.backend.auth,connected:true,preferred:true,login:{state:'connected'}};await s.run('refreshAuth()');await s.flush();assert.match(s.el('auth-status').textContent,/Connected/);assert.equal(s.el('auth-model').hidden,false);
 await s.el('auth-disconnect').emit('click');await s.flush();assert.equal(s.backend.auth.connected,false);
});

test('a stale auth status cannot hide a newer sign-in link',async()=>{
 const s=await setup();s.backend.status.mode='pi';await s.run('refresh()');await s.flush();let release;let waiting=false;let first=true;const gate=new Promise(r=>release=r);
 s.backend.beforeFetch=async({pathname,method})=>{if(pathname==='/api/auth'&&method==='GET'&&first){first=false;waiting=true;await gate;}};
 const old=s.run('refreshAuth()');for(let i=0;i<100&&!waiting;i++)await Promise.resolve();assert.equal(waiting,true);
 await s.el('auth-connect').emit('click');release();await old;await s.flush();assert.equal(s.el('auth-link').hidden,false);
});

const buttonsIn = (node) => node.querySelectorAll('*').filter(item => item.tag === 'button');
async function prepareSchedule(s, kind = 'once') {
  await s.el('schedules-tab').emit('click'); await s.flush();
  s.el('schedule-name').value = '<script>Weekly review</script>'; s.el('schedule-prompt').value = 'Review progress carefully.';
  s.el('schedule-kind').value = kind; await s.el('schedule-kind').emit('change');
  if (kind === 'once') s.el('schedule-run-at').value = new Date(Date.now() + 86_400_000).toISOString().slice(0,16);
  else { s.el('schedule-cron').value = '0 9 * * 1'; s.el('schedule-time-zone').value = 'Asia/Shanghai'; }
}

test('environment shows source, honest verification and empty deny-by-default policies', async () => {
  const s = await setup(); await s.createBot(); s.backend.status.mode = 'pi'; s.backend.status.sandboxProfile = 'service'; s.backend.status.capabilities.serviceProfile = true;
  await s.run('refresh()'); await s.el('environment-tab').emit('click'); await s.flush();
  assert.equal(s.el('tasks-view').hidden, true); assert.equal(s.el('environment-view').hidden, false);
  assert.match(s.el('environment-facts').textContent, /last recorded worker state/);
  assert.match(s.el('environment-capabilities').textContent, /governed HTTPS fetch/);
  assert.match(s.el('environment-verification').textContent, /Not live-verified/);
  assert.match(s.el('mode-description').textContent, /Not live-verified/);
  assert.equal(s.el('environment-packages').value, ''); assert.equal(s.el('environment-hosts').value, '');
  assert.match(s.el('environment-policy-version').textContent, /Default deny/);
  assert.equal(s.backend.calls.some(call => call.pathname.endsWith('/policy') || call.pathname.endsWith('/stop')), false);
});

test('operator policy edits preserve their original revision across polling and conflicting saves', async () => {
  const s = await setup(); const bot = await s.createBot(); await s.el('environment-tab').emit('click'); await s.flush();
  s.el('environment-packages').value = 'curl\ncurl\nca-certificates'; s.el('environment-hosts').value = 'docs.example.com'; await s.el('environment-packages').emit('input');
  const environment = s.backend.environments.get(bot.id); environment.policy.revision = 'new-server-revision';
  await s.run('refresh()'); await s.flush(); assert.equal(s.el('environment-packages').value, 'curl\ncurl\nca-certificates');
  await s.el('environment-policy-form').emit('submit');
  const call = s.backend.calls.filter(call => call.pathname.endsWith('/policy')).at(-1);
  assert.equal(call.body.expectedRevision, 'none'); assert.deepEqual(call.body.allowedPackages, ['curl','ca-certificates']);
  assert.match(s.el('environment-error').textContent, /changed/); assert.match(s.el('environment-packages').value, /curl/);
  await s.run('refresh()'); await s.flush(); assert.match(s.el('environment-error').textContent, /changed/);
  await s.el('environment-policy-reload').emit('click'); await s.flush(); assert.equal(s.el('environment-packages').value, '');
  s.el('environment-packages').value = 'curl'; await s.el('environment-packages').emit('input');
  await s.el('environment-policy-form').emit('submit'); assert.deepEqual(environment.policy.allowedPackages, ['curl']);
  assert.equal(s.el('environment-error').hidden, true);
});

test('environment stop is explicit, deduplicated and pending until worker confirmation', async () => {
  const s = await setup(); const bot = await s.createBot(); s.backend.status.capabilities.serviceProfile = true; await s.run('refresh()');
  await s.el('environment-tab').emit('click'); await s.flush();
  await s.el('environment-stop').emit('click'); assert.equal(s.backend.calls.some(call => call.pathname.endsWith('/stop')), false);
  await s.el('environment-stop-back').emit('click'); assert.equal(s.el('environment-stop-confirmation').hidden,true);
  await s.el('environment-stop').emit('click');
  s.backend.failStop = true; await s.el('environment-stop-confirm').emit('click'); assert.match(s.el('environment-error').textContent, /not confirmed/);
  s.backend.failStop = false; await Promise.all([s.el('environment-stop-confirm').emit('click'),s.el('environment-stop-confirm').emit('click')]); await s.flush();
  const stops = s.backend.calls.filter(call => call.pathname.endsWith('/stop')); assert.equal(stops.length,2); assert.equal(stops[0].body.requestId,stops[1].body.requestId);
  assert.match(s.el('environment-stop-status').textContent,/pending/); assert.match(s.el('environment-facts').textContent,/running/); assert.equal(s.el('environment-stop').disabled,true);
  s.backend.environments.get(bot.id).state = 'stopped'; s.backend.environments.get(bot.id).stop.state = 'succeeded'; await s.run('loadEnvironment()');
  assert.match(s.el('environment-stop-status').textContent,/succeeded/); assert.equal(s.el('environment-stop').disabled,true);
});

test('non-service environments cannot submit stop, and failed loads remain visible', async () => {
  const s = await setup(); await s.createBot(); await s.el('environment-tab').emit('click'); await s.flush();
  assert.equal(s.el('environment-stop').disabled,true); await s.el('environment-stop').emit('click'); await s.el('environment-stop-confirm').emit('click');
  assert.equal(s.backend.calls.some(call => call.pathname.endsWith('/stop')),false);
  s.backend.failEnvironment = true; await s.el('environment-refresh').emit('click'); assert.match(s.el('environment-error').textContent,/unavailable/); assert.match(s.el('environment-facts').textContent,/running/);
  s.backend.failEnvironment = false; await s.el('environment-refresh').emit('click'); assert.equal(s.el('environment-error').hidden,true);
});

test('switching bots aborts stale environment loads and keeps policy drafts scoped', async () => {
  const s = await setup(); const first = await s.createBot('First'); const second = await s.createBot('Second');
  s.run(`selectBot(${JSON.stringify(first.id)})`); await s.flush(); await s.el('environment-tab').emit('click'); await s.flush();
  s.el('environment-packages').value = 'curl'; await s.el('environment-packages').emit('input');
  let release, signal; const gate = new Promise(resolve => release = resolve);
  s.backend.beforeFetch = async call => { if(call.pathname === `/api/bots/${first.id}/environment`) { signal = call.signal; await gate; } };
  const pending = s.run('loadEnvironment()'); await s.flush(); assert.ok(signal);
  s.run(`selectBot(${JSON.stringify(second.id)})`); await s.flush(); assert.equal(signal.aborted,true); release(); await pending; await s.flush();
  assert.equal(s.el('environment-packages').value,''); assert.match(s.el('environment-facts').textContent,new RegExp(second.id));
  s.backend.beforeFetch = null; s.run(`selectBot(${JSON.stringify(first.id)})`); await s.flush(); assert.equal(s.el('environment-packages').value,'curl');
});

test('leaving environment dismisses stop confirmation and aborts in-flight reads', async () => {
  const s = await setup(); await s.createBot(); s.backend.status.capabilities.serviceProfile = true; await s.run('refresh()'); await s.el('environment-tab').emit('click'); await s.flush();
  await s.el('environment-stop').emit('click'); let signal, release; const gate = new Promise(resolve => release = resolve);
  s.backend.beforeFetch = async call => {if(call.pathname.endsWith('/environment')) {signal=call.signal; await gate;}};
  const pending=s.run('loadEnvironment()'); await s.flush(); await s.el('tasks-tab').emit('click'); assert.equal(signal.aborted,true); assert.equal(s.el('environment-stop-confirmation').hidden,true);
  release(); await pending; await s.flush(); assert.equal(s.el('environment-view').hidden,true);
});

test('schedule creation submits exact UTC once time, prevents duplicates, and retains retry IDs', async () => {
  const s = await setup(); await s.createBot(); await prepareSchedule(s);
  const expected = Date.parse(`${s.el('schedule-run-at').value}Z`); s.backend.failCreateSchedule = true;
  await s.el('schedule-form').emit('submit'); assert.match(s.el('schedule-form-error').textContent,/not confirmed/); assert.equal(s.el('schedule-prompt').value,'Review progress carefully.');
  s.backend.failCreateSchedule = false; await Promise.all([s.el('schedule-form').emit('submit'),s.el('schedule-form').emit('submit')]); await s.flush();
  const calls = s.backend.calls.filter(call => call.pathname.endsWith('/schedules') && call.method === 'POST');
  assert.equal(calls.length,2); assert.equal(calls[0].body.requestId,calls[1].body.requestId); assert.equal(calls[1].body.runAt,expected); assert.equal(calls[1].body.timeZone,'UTC');
  assert.equal(s.backend.schedules.length,1); assert.equal(s.el('schedule-prompt').value,''); assert.match(s.el('schedule-list').textContent,/<script>Weekly review<\/script>/);
});

test('cron schedules validate time zones and fields before sending and preserve named zones', async () => {
  const s = await setup(); await s.createBot(); await prepareSchedule(s,'cron');
  assert.equal(s.el('schedule-once-fields').hidden,true); s.el('schedule-time-zone').value = 'invalid-zone'; await s.el('schedule-form').emit('submit'); assert.match(s.el('schedule-form-error').textContent,/IANA/);
  s.el('schedule-time-zone').value = 'Asia/Shanghai'; s.el('schedule-cron').value = '* *'; await s.el('schedule-form').emit('submit'); assert.match(s.el('schedule-form-error').textContent,/five cron/);
  assert.equal(s.backend.schedules.length,0); s.el('schedule-cron').value = '0  9 * * 1'; await s.el('schedule-form').emit('submit');
  assert.equal(s.backend.schedules[0].cron,'0 9 * * 1'); assert.equal(s.backend.schedules[0].timeZone,'Asia/Shanghai'); assert.equal(s.backend.schedules[0].kind,'cron');
});

test('one-time schedules reject past or impossible UTC dates without dispatch', async () => {
  const s = await setup(); await s.createBot(); await prepareSchedule(s);
  for(const value of ['2020-01-01T10:00','2030-02-30T10:00','not-a-date']) {s.el('schedule-run-at').value=value;await s.el('schedule-form').emit('submit');assert.match(s.el('schedule-form-error').textContent,/future date/);}
  assert.equal(s.backend.schedules.length,0);
});

test('schedule pause/resume and two-step delete preserve queued tasks and durable history', async () => {
  const s = await setup(); await s.createBot(); const task = await s.submit(); await prepareSchedule(s); await s.el('schedule-form').emit('submit');
  const schedule = s.backend.schedules[0]; schedule.lastFireAt=Date.now();schedule.lastTaskId=task.id;
  s.backend.fires.push({scheduleId:schedule.id,taskId:task.id,scheduledAt:Date.now(),observedAt:Date.now(),outcome:'queued',coalesced:true});
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Pause').emit('click'); assert.equal(schedule.state,'paused');
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Resume').emit('click'); assert.equal(schedule.state,'active');
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Run history').emit('click'); await s.flush();
  assert.match(s.el('schedule-history-list').textContent,/Task queued/); assert.match(s.el('schedule-history-list').textContent,/coalesced/); assert.doesNotMatch(s.el('schedule-history-list').textContent,/Completed/);
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Delete').emit('click'); assert.equal(schedule.state,'active');
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Keep schedule').emit('click'); assert.equal(schedule.state,'active');
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Delete').emit('click');
  await buttonsIn(s.el('schedule-list')).find(button => button.textContent==='Confirm delete').emit('click'); assert.equal(schedule.state,'deleted'); assert.equal(s.backend.tasks.length,1); assert.equal(s.backend.fires.length,1);
});

test('schedule read and mutation failures retain the list and show recoverable errors', async () => {
  const s = await setup(); await s.createBot(); await prepareSchedule(s); await s.el('schedule-form').emit('submit');
  s.backend.failSchedules = true; await s.el('schedules-refresh').emit('click'); assert.match(s.el('schedules-error').textContent,/unavailable/); assert.match(s.el('schedule-list').textContent,/Weekly review/);
  s.backend.failSchedules = false; await s.el('schedules-refresh').emit('click'); s.backend.failScheduleChange=true;
  await buttonsIn(s.el('schedule-list')).find(button=>button.textContent==='Pause').emit('click'); assert.match(s.el('schedules-error').textContent,/not confirmed/); assert.equal(s.backend.schedules[0].state,'active');
});

test('schedule history Close and bot navigation fence stale reads and retain separate drafts', async () => {
  const s = await setup(); const first=await s.createBot('First'); await prepareSchedule(s); await s.el('schedule-form').emit('submit'); const schedule=s.backend.schedules[0];
  let release,signal;const gate=new Promise(resolve=>release=resolve);s.backend.beforeFetch=async call=>{if(call.pathname.endsWith('/history')){signal=call.signal;await gate;}};
  const pending=s.run(`showScheduleHistory(${JSON.stringify(schedule.id)})`);await s.flush();await s.el('schedule-history-close').emit('click');assert.equal(signal.aborted,true);release();await pending;assert.equal(s.el('schedule-history-panel').hidden,true);
  s.backend.beforeFetch=null;s.el('schedule-prompt').value='Draft for first';await s.el('schedule-prompt').emit('input');const second=await s.createBot('Second');await s.flush();assert.equal(s.el('schedule-prompt').value,'');
  let releaseList,listSignal;const listGate=new Promise(resolve=>releaseList=resolve);s.backend.beforeFetch=async call=>{if(call.pathname===`/api/bots/${second.id}/schedules`){listSignal=call.signal;await listGate;}};
  const old=s.run('loadSchedules()');await s.flush();s.run(`selectBot(${JSON.stringify(first.id)})`);await s.flush();assert.equal(listSignal.aborted,true);releaseList();await old;await s.flush();
  assert.equal(s.el('schedule-prompt').value,'Draft for first');assert.match(s.el('schedule-list').textContent,/Weekly review/);
});

test('Telegram readiness is read-only, token-free and separates configuration from delivery', async () => {
  const s = await setup(); const bot=await s.createBot();s.backend.status.channels.telegram={enabled:true,configured:true,mode:'private-long-poll',botId:bot.id,online:false,status:'not-started',lastSeen:null,lastError:null,deliveries:{uncertain:2},token:'must-not-render'};
  await s.run('refresh()');assert.match(s.el('telegram-status').textContent,/not-started/);assert.match(s.el('telegram-facts').textContent,/uncertain: 2/);assert.doesNotMatch(s.el('telegram-facts').textContent,/must-not-render/);
  s.backend.status.channels.telegram.online=true;await s.run('refresh()');assert.match(s.el('telegram-status').textContent,/does not prove delivery/);
  assert.equal(s.backend.calls.some(call=>call.pathname.includes('/telegram')&&call.method!=='GET'),false);
});

test('an ambiguous one-time create can retry the same request after its due time passes', async () => {
  const s=await setup();await s.createBot();await prepareSchedule(s);s.backend.failCreateSchedule=true;await s.el('schedule-form').emit('submit');
  const first=s.backend.calls.filter(call=>call.pathname.endsWith('/schedules')&&call.method==='POST').at(-1);
  // Model a server commit whose response was lost, then advance only this VM clock.
  s.backend.schedules.push({...first.body,botId:s.backend.bots[0].id,id:webcrypto.randomUUID(),state:'completed',nextRunAt:null,lastFireAt:first.body.runAt,lastTaskId:null});
  s.backend.failCreateSchedule=false;s.run(`Date.now = () => ${first.body.runAt+60_000}`);await s.el('schedule-form').emit('submit');
  const calls=s.backend.calls.filter(call=>call.pathname.endsWith('/schedules')&&call.method==='POST');assert.equal(calls.length,2);assert.equal(calls[0].body.requestId,calls[1].body.requestId);assert.equal(s.backend.schedules.length,1);assert.equal(s.el('schedule-form-error').hidden,true);
});

test('unchanged schedule polling retains action nodes and keyboard focus targets', async () => {
  const s=await setup();await s.createBot();await prepareSchedule(s);await s.el('schedule-form').emit('submit');
  const button=buttonsIn(s.el('schedule-list')).find(item=>item.textContent==='Pause');await s.run('refresh()');await s.flush();
  assert.equal(buttonsIn(s.el('schedule-list')).find(item=>item.textContent==='Pause'),button);
});

test('demo first use does not request or offer a model login',async()=>{
  const s=await setup();assert.equal(s.el('auth-panel').hidden,true);await s.el('auth-connect').emit('click');await s.flush();assert.equal(s.backend.calls.some(c=>c.pathname.startsWith('/api/auth')),false);assert.equal(s.el('onboarding').hidden,false);
});
test('an unaccepted send survives reload with its exact request ID and without automatic POST',async()=>{
  const s=await setup();await s.createBot();s.backend.failNextTask=true;await s.submit('Keep this through reload.');
  const first=s.backend.calls.find(c=>c.method==='POST'&&c.pathname.endsWith('/tasks'));
  const next=await setup(s);assert.equal(next.el('task-prompt').value,'Keep this through reload.');assert.equal(next.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).length,1);assert.equal(next.el('chat-recovery').hidden,false);
  await next.submit('Keep this through reload.');assert.equal(next.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).at(-1).body.messageId,first.body.messageId);assert.equal(next.backend.tasks.length,1);
});
test('lost accepted task reply is reconciled read-only after reload, showing one durable result',async()=>{
  const s=await setup();await s.createBot();s.backend.dropTaskAck=true;await s.submit('Accepted despite a lost reply.');const task=s.backend.tasks[0];task.state='succeeded';task.result='Demo result remains available.';
  const next=await setup(s);await next.flush();assert.equal(next.el('task-prompt').value,'');assert.equal(next.el('detail-state').textContent,'Completed');assert.equal(next.el('task-result').textContent,task.result);assert.equal(next.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).length,1);assert.equal(next.backend.tasks.length,1);
});
test('Bot create retry across reload keeps its creation UUID',async()=>{
  const s=await setup();s.backend.failNextBot=true;await s.createBot('New companion');const first=s.backend.calls.find(c=>c.method==='POST'&&c.pathname==='/api/bots');
  const next=await setup(s);await next.el('first-bot').emit('click');assert.equal(next.el('bot-name').value,'New companion');await next.createBot('New companion');assert.equal(next.backend.calls.filter(c=>c.method==='POST'&&c.pathname==='/api/bots').at(-1).body.requestId,first.body.requestId);assert.equal(next.backend.bots.length,1);
});
test('lost Bot creation acknowledgment resolves from its receipt without creating another Bot',async()=>{
  const s=await setup();s.backend.dropBotAck=true;await s.createBot('One companion');const next=await setup(s);await next.flush();assert.equal(next.backend.bots.length,1);assert.equal(next.backend.calls.filter(c=>c.method==='POST'&&c.pathname==='/api/bots').length,1);assert.equal(next.run('state.botDraft'),'');
});
test('selected task and ordinary drafts survive reload; old steer text is never converted into follow-up',async()=>{
  const s=await setup();await s.createBot();const first=await s.submit('First');await s.submit('Second');s.run(`selectTask(${JSON.stringify(first.id)})`);first.state='running';await s.run('refresh()');await s.el('steer-tab').emit('click');
  s.el('task-prompt').value='An unsent fresh task.';await s.el('task-prompt').emit('input');s.el('command-text').value='An unsent direction.';await s.el('command-text').emit('input');first.state='succeeded';
  const next=await setup(s);assert.equal(next.el('detail-prompt').textContent,'First');assert.equal(next.el('task-prompt').value,'An unsent fresh task.');assert.equal(next.el('command-text').value,'An unsent direction.');assert.equal(next.el('submit-command').disabled,true);assert.match(next.el('command-help').textContent,/no longer running/);
  const count=next.backend.calls.filter(c=>c.pathname.endsWith('/commands')).length;await next.el('command-form').emit('submit');assert.equal(next.backend.calls.filter(c=>c.pathname.endsWith('/commands')).length,count);
});
test('failed result can prepare a new task without automatic execution or overwriting another draft',async()=>{
  const s=await setup();await s.createBot();const task=await s.submit('Recover this task.');task.state='failed';task.error='Worker setup is unavailable.';await s.run('refresh()');
  await s.el('reuse-task').emit('click');assert.equal(s.el('task-prompt').value,task.prompt);assert.equal(s.backend.tasks.length,1);await s.submit(task.prompt);assert.equal(s.backend.tasks.length,2);assert.notEqual(s.backend.tasks[0].id,task.id);assert.equal(task.state,'failed');
  s.run(`selectTask(${JSON.stringify(task.id)})`);s.el('task-prompt').value='My other draft';await s.el('reuse-task').emit('click');assert.equal(s.el('task-prompt').value,'My other draft');assert.match(s.el('task-form-error').textContent,/existing draft is kept/);
});
test('chat journal excludes model callback/maintenance state and corrupt journals never execute requests',async()=>{
  const s=await setup();s.run("state.auth={access:'credential-must-not-be-saved'};state.submissions.set('auth-callback',{id:'ignored',signature:'credential-must-not-be-saved'});saveChat()");assert.ok(!s.session.get('chestnut.chat.v1').includes('credential-must-not-be-saved'));
  const bad=await setup({session:new Map([['chestnut.chat.v1','{broken']])});assert.equal(bad.el('onboarding').hidden,false);assert.equal(bad.backend.calls.some(c=>c.method==='POST'),false);
});

test('actual chat journal functions round-trip supported drafts and pending IDs above the former read limit',async()=>{
  const s=await setup();
  s.run(`
    state.botDraft='b'.repeat(80);
    for(let i=0;i<20;i++){const botId=crypto.randomUUID();state.drafts.set(botId,'t'.repeat(32000));state.selectedTasks.set(botId,crypto.randomUUID());}
    for(let i=0;i<30;i++){
      const taskId=crypto.randomUUID(),botId=crypto.randomUUID();
      state.commandDrafts.set(taskId,'c'.repeat(32000));
      state.commandKinds.set(taskId,'steer');
      submission('command:'+taskId+':steer',{botId,taskId,type:'steer',text:'p'.repeat(32000)});
    }
    saveChat();
  `);
  assert.ok(s.session.get('chestnut.chat.v1').length>2000000);assert.equal(s.run('state.chatStored'),true);
  const before=s.run('JSON.stringify({botDraft:state.botDraft,drafts:[...state.drafts],commands:[...state.commandDrafts],kinds:[...state.commandKinds],selected:[...state.selectedTasks],pending:[...state.submissions]})');
  const next=await setup(s);assert.equal(next.run('JSON.stringify({botDraft:state.botDraft,drafts:[...state.drafts],commands:[...state.commandDrafts],kinds:[...state.commandKinds],selected:[...state.selectedTasks],pending:[...state.submissions]})'),before);
  assert.equal(next.run('state.chatStored'),true);assert.equal(next.backend.calls.some(call=>call.method==='POST'),false);
  // Escaping can expand valid field sizes much further than their input length.
  s.run(`state.drafts=new Map([...state.drafts].map(([key])=>[key,'\\u0001'.repeat(32000)]));state.commandDrafts=new Map([...state.commandDrafts].map(([key])=>[key,'\\u0001'.repeat(32000)]));state.submissions=new Map([...state.submissions].map(([key,value])=>[key,{...value,signature:JSON.stringify({...JSON.parse(value.signature),text:'\\u0001'.repeat(32000)})}]));saveChat()`);
  assert.ok(s.session.get('chestnut.chat.v1').length>13000000);assert.equal(s.run('state.chatStored'),true);assert.ok(s.run('[...state.submissions.values()].every(value=>value.signature.length>192000)'));
  const escaped=s.run('JSON.stringify({botDraft:state.botDraft,drafts:[...state.drafts],commands:[...state.commandDrafts],kinds:[...state.commandKinds],selected:[...state.selectedTasks],pending:[...state.submissions]})');
  const reloaded=await setup(s);assert.equal(reloaded.run('JSON.stringify({botDraft:state.botDraft,drafts:[...state.drafts],commands:[...state.commandDrafts],kinds:[...state.commandKinds],selected:[...state.selectedTasks],pending:[...state.submissions]})'),escaped);assert.equal(reloaded.backend.calls.some(call=>call.method==='POST'),false);
});

test('storage quota failure retains the prior journal and in-tab drafts/IDs and warns even without a pending send',async()=>{
  const s=await setup();await s.createBot();s.el('task-prompt').value='Saved draft';await s.el('task-prompt').emit('input');const prior=s.session.get('chestnut.chat.v1');
  s.run("sessionStorage.setItem=()=>{throw new Error('QuotaExceededError')}");s.el('task-prompt').value='Keep in this tab';await s.el('task-prompt').emit('input');
  assert.equal(s.run('state.chatStored'),false);assert.equal(s.session.get('chestnut.chat.v1'),prior);assert.equal(s.run('state.drafts.get(state.botId)'),'Keep in this tab');
  assert.equal(s.el('chat-recovery').hidden,false);assert.match(s.el('chat-recovery').textContent,/copy unsent drafts before reloading/);
  s.backend.failNextTask=true;await s.submit('Keep in this tab');const id=s.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).at(-1).body.messageId;
  assert.equal(s.run('state.submissions.get("task:"+state.botId).id'),id);assert.equal(s.session.get('chestnut.chat.v1'),prior);assert.equal(s.el('chat-recovery').hidden,false);
  const restored=await setup(s);assert.equal(restored.el('task-prompt').value,'Saved draft');
});

test('escaped task/Steer/follow-up sends retain their original IDs through reload and explicit retry',async()=>{
  const text=String.fromCharCode(1).repeat(20000);
  let s=await setup();await s.createBot();s.backend.failNextTask=true;await s.submit(text);
  const first=s.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).at(-1),postCount=s.backend.calls.filter(c=>c.method==='POST').length;
  assert.ok(s.run('state.submissions.get("task:"+state.botId).signature.length')>120000);
  s=await setup(s);assert.equal(s.el('task-prompt').value,text);assert.equal(s.run('state.submissions.get("task:"+state.botId).id'),first.body.messageId);assert.equal(s.backend.calls.filter(c=>c.method==='POST').length,postCount);
  const task=await s.submit(text);assert.equal(s.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/tasks')).at(-1).body.messageId,first.body.messageId);task.state='running';await s.run('refresh()');
  for(const type of ['steer','follow_up']){
    s.run(`selectTask(${JSON.stringify(task.id)})`);await s.flush();await s.el(type==='steer'?'steer-tab':'follow-up-tab').emit('click');s.el('command-text').value=text;await s.el('command-text').emit('input');s.backend.failNextCommand=true;await s.el('command-form').emit('submit');
    const call=s.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/commands')).at(-1),count=s.backend.calls.filter(c=>c.method==='POST').length;
    assert.ok(s.run(`state.submissions.get('command:'+state.taskId+':${type}').signature.length`)>120000);
    s=await setup(s);assert.equal(s.el('command-text').value,text);assert.equal(s.run(`state.submissions.get('command:'+state.taskId+':${type}').id`),call.body.messageId);assert.equal(s.backend.calls.filter(c=>c.method==='POST').length,count);
    await s.el('command-form').emit('submit');assert.equal(s.backend.calls.filter(c=>c.method==='POST'&&c.pathname.endsWith('/commands')).at(-1).body.messageId,call.body.messageId);
  }
});
