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
async function setup() {
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
  const backend = { bots: [], tasks: [], events: [], memories: [], maintenance: { job: {state:'succeeded',provider:'explicit-demo',automatic:true}, progress: {cursor:7,lastDreamAt:Date.now(),conflicts:[]} }, memoryVersion: 'a'.repeat(40), memoryEnabled: true, memoryProject: null, status: { mode: 'demo', worker: { online: true }, quarantines: [] }, calls: [], failNextTask: false, failNetwork: false };
  const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(payload) });
  const task = (botId, prompt) => { const result = { id: webcrypto.randomUUID(), botId, prompt, state: 'queued', result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() }; backend.tasks.unshift(result); return result; };
  const fetch = async (url, options = {}) => {
    const pathname = url.split('?')[0]; const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : undefined;
    backend.calls.push({ pathname, url, method, body });
    if (backend.beforeFetch) await backend.beforeFetch({ pathname, method });
    if (backend.failNetwork) throw new TypeError('offline');
    if (pathname === '/api/status') return response(backend.status);
    if (pathname === '/api/bots' && method === 'GET') return response(backend.bots);
    if (pathname === '/api/bots' && method === 'POST') { const bot = { id: webcrypto.randomUUID(), name: body.name, createdAt: Date.now() }; backend.bots.push(bot); return response(bot); }
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
      if (body.type === 'follow_up') return response(task(botId, body.text));
      if (body.type === 'cancel') backend.tasks.find((entry) => entry.id === taskId).state = 'cancelling';
      return response({ id: webcrypto.randomUUID(), ...body });
    }
    if (method === 'GET') return response(backend.tasks.filter((entry) => entry.botId === botId));
    if (backend.failNextTask) { backend.failNextTask = false; return response({ error: 'Try again later.' }, 503); }
    return response(task(botId, body.prompt));
  };
  const timers = new Map(); let nextTimer = 0;
  const context = vm.createContext({ document, window: new Node('window'), navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: () => null, setItem() {} }, crypto: webcrypto, fetch, AbortController, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id), console, TypeError });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
  const run = (source) => vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
  await flush();
  const el = (id) => elements.get(id);
  const createBot = async (name = 'Research companion') => { el('bot-name').value = name; await el('bot-form').emit('submit'); await flush(); return backend.bots.at(-1); };
  const submit = async (prompt = 'A thoughtful test task.') => { el('task-prompt').value = prompt; await el('task-form').emit('submit'); await flush(); return backend.tasks.at(0); };
  return { run, flush, el, backend, createBot, submit, document, timers };
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
