/** Chestnut's build-free dashboard. All API text is rendered as text, never HTML. */
const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const LABELS = { queued: 'Queued', running: 'Running', cancelling: 'Cancelling', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const MARKS = ['✳', '✦', '❋', '◈', '⌘', '✺'];
const state = {
  status: null, connected: false, bots: [], botId: null, tasks: [], taskId: null,
  events: new Map(), drafts: new Map(), commandDrafts: new Map(),
  submissions: new Map(), commandType: 'follow_up', refreshing: false,
  refreshAgain: false, botRevision: 0, eventTaskId: null,
  busy: { bot: false, task: false, command: false }, tasksLoaded: false,
};
let toastTimer;
let pollTimer;
let taskListSignature = '';
let botListSignature = '';
let eventSignature = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // randomUUID requires a secure context. getRandomValues also works on local LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function submission(key, payload) {
  const signature = JSON.stringify(payload);
  const previous = state.submissions.get(key);
  if (previous?.signature === signature) return previous.id;
  const id = uuid();
  state.submissions.set(key, { signature, id });
  return id;
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      ...options, signal: controller.signal, cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const message = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      throw new Error(message || `The request failed (${response.status}).`);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server took too long to respond. The request may have reached the server.');
    if (error instanceof TypeError) throw new Error('Cannot reach the server. Check that Chestnut is running, then try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const botPath = (id = state.botId) => `/api/bots/${encodeURIComponent(id)}/tasks`;
const taskPath = (botId = state.botId, taskId = state.taskId) => `${botPath(botId)}/${encodeURIComponent(taskId)}`;
const currentTask = () => state.tasks.find((task) => task.id === state.taskId);
function readable(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}
function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function shortTime(value) {
  const date = dateValue(value);
  if (!date) return '—';
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fullDate(value) { return dateValue(value)?.toLocaleString() || 'Time unavailable'; }
function setError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function statePill(value) { return element('span', `state-pill ${LABELS[value] ? value : ''}`, LABELS[value] || value || 'Unknown'); }
function renderStatus() {
  const quarantines = state.status?.quarantines || [];
  $('quarantine-banner').hidden = !quarantines.length;
  const quarantineMessage = quarantines.map((entry) => `Sandbox cleanup blocked for task ${String(entry.taskId || entry.runId).slice(0, 8)}: ${entry.reason || 'Manual inspection is required.'}`).join(' • ');
  if ($('quarantine-description').textContent !== quarantineMessage) $('quarantine-description').textContent = quarantineMessage;
  const connection = $('connection-status');
  const connectionLabel = state.connected ? 'Connected' : state.status ? 'Reconnecting' : 'Connecting';
  if (connection.textContent !== connectionLabel) connection.replaceChildren(element('span', `status-dot ${state.connected ? 'online' : 'offline'}`), element('span', '', connectionLabel));
  const workerOnline = state.connected && !!state.status?.worker?.online;
  $('worker-dot').className = `status-dot ${workerOnline ? 'online' : 'offline'}`;
  $('worker-label').textContent = workerOnline ? 'Worker connected' : state.connected ? 'Worker offline' : 'Waiting for connection';
  $('worker-description').textContent = workerOnline ? 'Ready to pick up your next task.' : state.connected ? 'Tasks can be queued. They’ll start when a worker connects.' : 'Your task history stays on the server.';
  if (state.status?.mode === 'demo') {
    $('mode-banner').className = 'mode-banner';
    const description = 'Demo mode · No real AI calls or agent shell commands; results are simulated.';
    if ($('mode-description').textContent !== description) $('mode-description').textContent = description;
    $('composer-hint').textContent = 'Demo tasks are simulated, without AI or shell access.';
  } else if (state.status?.mode === 'pi') {
    $('mode-banner').className = 'mode-banner live';
    const description = state.status?.sandboxProfile === 'persistent' ? 'Experimental persistent root · OS files persist. The entire bot stops after each task; services do not stay running. No outbound Internet.' : 'Pi mode · Read-only OS, persistent workspace. Tasks run through your configured Pi worker.';
    if ($('mode-description').textContent !== description) $('mode-description').textContent = description;
    $('composer-hint').textContent = 'One task at a time in this workspace.';
  }
}
function renderBots() {
  const signature = JSON.stringify([state.bots, state.botId]);
  if (signature !== botListSignature) {
    botListSignature = signature;
    const list = $('bot-list'); list.replaceChildren();
    if (!state.bots.length) list.append(element('div', 'list-loading', 'Your first bot belongs here.'));
    state.bots.forEach((bot, index) => {
      const button = element('button', `bot-button${bot.id === state.botId ? ' selected' : ''}`);
      button.type = 'button'; button.dataset.botId = bot.id;
      button.setAttribute('aria-current', bot.id === state.botId ? 'page' : 'false');
      button.setAttribute('aria-label', `Open ${bot.name}`);
      button.title = bot.name;
      button.append(element('span', 'bot-avatar', MARKS[index % MARKS.length]), element('span', 'bot-name', bot.name));
      if (bot.id === state.botId) button.append(element('span', 'bot-selected-dot'));
      button.addEventListener('click', () => selectBot(bot.id)); list.append(button);
    });
  }
  $('bot-count').textContent = state.bots.length;
  const bot = state.bots.find((entry) => entry.id === state.botId);
  $('onboarding').hidden = !!bot || !state.connected;
  $('bot-workspace').hidden = !bot;
  $('workspace-title').textContent = bot ? bot.name : 'Good work starts here.';
  $('workspace-subtitle').textContent = bot ? 'A little direction from you. A little progress, together.' : 'A home for your bots, their tasks, and the ideas in between.';
  $('breadcrumb-bot').textContent = bot?.name || 'Overview';
  $('bot-mark').textContent = bot ? MARKS[state.bots.indexOf(bot) % MARKS.length] : '✳';
  $('bot-mark').hidden = !bot;
}
function renderTasks() {
  const signature = JSON.stringify([state.tasks, state.taskId, state.tasksLoaded]);
  if (signature === taskListSignature) return;
  taskListSignature = signature;
  const list = $('task-list'); list.replaceChildren();
  $('task-count').textContent = state.tasks.length;
  const running = state.tasks.filter((task) => ACTIVE.has(task.state)).length;
  $('task-summary').textContent = running ? `${running} active` : state.tasks.length >= 200 ? 'Latest 200' : 'All tasks';
  if (!state.tasks.length) {
    const empty = element('div', 'empty-tasks');
    empty.append(element('strong', '', state.tasksLoaded ? 'A fresh page.' : 'Loading task history…'));
    if (state.tasksLoaded) empty.append(element('span', '', 'Your tasks will show up here. Start with something small.'));
    list.append(empty); return;
  }
  [...state.tasks].sort((a, b) => (dateValue(b.createdAt)?.getTime() || 0) - (dateValue(a.createdAt)?.getTime() || 0)).forEach((task) => {
    const button = element('button', `task-card${task.id === state.taskId ? ' selected' : ''}`);
    button.type = 'button'; button.dataset.taskId = task.id;
    button.setAttribute('aria-pressed', String(task.id === state.taskId));
    const head = element('div', 'task-card-head');
    const time = element('span', 'section-meta', shortTime(task.createdAt)); time.title = fullDate(task.createdAt);
    head.append(statePill(task.state), time);
    const foot = element('div', 'task-card-foot');
    foot.append(element('span', '', `Task ${task.id.slice(0, 8)}`), element('span', 'task-card-arrow', '↗'));
    button.append(head, element('p', 'task-card-prompt', task.prompt), foot);
    button.addEventListener('click', () => selectTask(task.id)); list.append(button);
  });
}
function stateNote(task) {
  if (task.state === 'queued') return state.status?.worker?.online ? 'Queued and waiting for a worker to pick it up.' : 'Queued. This task will wait until a worker connects.';
  if (task.state === 'cancelling') return 'Cancellation requested. Waiting for the worker to confirm it has stopped.';
  if (task.state === 'cancelled') return 'This task was cancelled. Any partial output is kept below. Use the main composer to start a fresh task.';
  if (task.state === 'interrupted') return 'This run was interrupted. Review the activity, then use the main composer to start a fresh task.';
  return '';
}
function renderDetail() {
  const task = currentTask();
  $('detail-empty').hidden = !!task; $('detail-content').hidden = !task;
  if (!task) { renderControls(); return; }
  $('detail-state').className = `state-pill ${LABELS[task.state] ? task.state : ''}`;
  $('detail-state').textContent = LABELS[task.state] || task.state;
  $('detail-date').textContent = shortTime(task.createdAt); $('detail-date').title = fullDate(task.createdAt);
  $('detail-prompt').textContent = task.prompt;
  $('detail-id').textContent = `Task ${task.id.slice(0, 8)}`; $('detail-id').title = task.id;
  const note = stateNote(task); $('task-state-note').textContent = note; $('task-state-note').hidden = !note;
  const hasError = !!task.error;
  const result = readable(task.result);
  const output = hasError ? [result, readable(task.error)].filter(Boolean).join('\n\nError: ') : result;
  $('result-section').hidden = !output;
  $('result-section').classList.toggle('is-error', hasError);
  $('result-label').textContent = hasError ? result ? 'Output and error' : 'Error' : task.state === 'succeeded' ? 'Result' : 'Output';
  $('task-result').textContent = output;
  renderEvents(); renderControls();
}
function renderEvents() {
  const task = currentTask(); if (!task) return;
  const events = state.events.get(task.id) || [];
  const signature = JSON.stringify([task.id, events]);
  $('event-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  if (signature === eventSignature) return;
  eventSignature = signature;
  const log = $('event-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  const openSeqs = new Set([...log.querySelectorAll('details[open]')].map((node) => node.dataset.seq));
  const oldScroll = log.scrollTop;
  const sameTask = state.eventTaskId === task.id;
  log.replaceChildren(); state.eventTaskId = task.id;
  if (!events.length) log.append(element('p', 'empty-events', 'No events yet. Activity will appear here as it happens.'));
  for (const event of events) {
    const item = element('details', 'event-item'); item.dataset.seq = String(event.seq);
    if (sameTask && openSeqs.has(String(event.seq))) item.open = true;
    const summary = element('summary');
    const label = String(event.type || 'event').replace(/[._-]/g, ' ');
    const time = element('span', 'event-time', shortTime(event.createdAt)); time.title = fullDate(event.createdAt);
    summary.append(element('span', '', label.charAt(0).toUpperCase() + label.slice(1)), time);
    item.append(summary, element('pre', '', readable(event.data) || 'No additional details.'));
    log.append(item);
  }
  log.scrollTop = !sameTask || atBottom ? log.scrollHeight : oldScroll;
}
function renderControls() {
  const task = currentTask();
  $('submit-task').disabled = !state.botId || state.busy.task || !$('task-prompt').value.trim();
  $('submit-task').textContent = state.busy.task ? 'Sending…' : 'Start task ↗';
  $('task-prompt').readOnly = state.busy.task;
  $('new-bot').disabled = state.busy.bot;
  $('first-bot').disabled = state.busy.bot;
  $('create-bot-submit').disabled = state.busy.bot;
  $('bot-name').readOnly = state.busy.bot;
  $('close-dialog').disabled = state.busy.bot;
  $('create-bot-submit').textContent = state.busy.bot ? 'Creating…' : 'Create bot ↗';
  const canSteer = task?.state === 'running';
  const canFollowUp = !!task && !['cancelled', 'interrupted', 'cancelling'].includes(task.state);
  if (!canSteer && state.commandType === 'steer') state.commandType = 'follow_up';
  $('steer-tab').disabled = !canSteer || state.busy.command;
  $('steer-tab').title = canSteer ? 'Apply a direction at the next worker boundary' : 'Steering is available while a task is running';
  $('follow-up-tab').disabled = !canFollowUp || state.busy.command;
  for (const tab of document.querySelectorAll('[data-command]')) {
    const active = tab.dataset.command === state.commandType;
    tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
  }
  $('command-help').textContent = !canFollowUp ? 'Use the main composer to start a fresh task. Follow-ups are unavailable after cancellation or interruption.' : state.commandType === 'steer' ? 'Send a direction for the next worker boundary. It may not apply if the task finishes first.' : 'Queue a new task for this bot. This does not change the selected task.';
  $('command-text').placeholder = state.commandType === 'steer' ? 'Add a direction for the current task…' : 'What would you like to do next?';
  $('command-text').readOnly = state.busy.command || !canFollowUp;
  $('submit-command').textContent = state.busy.command ? 'Sending…' : state.commandType === 'steer' ? 'Send direction ↗' : 'Queue follow-up ↗';
  $('submit-command').disabled = !task || !canFollowUp || state.busy.command || !$('command-text').value.trim();
  $('cancel-task').hidden = !task || !ACTIVE.has(task.state);
  $('cancel-task').disabled = state.busy.command || task?.state === 'cancelling';
  $('cancel-task').textContent = task?.state === 'cancelling' ? 'Cancelling…' : 'Cancel task';
}
function selectBot(id) {
  if (id === state.botId) return;
  if (state.botId) state.drafts.set(state.botId, $('task-prompt').value);
  if (state.taskId) state.commandDrafts.set(state.taskId, $('command-text').value);
  state.botId = id; state.taskId = null; state.tasks = []; state.tasksLoaded = false; state.botRevision++;
  $('task-prompt').value = state.drafts.get(id) || ''; $('command-text').value = '';
  setError('task-form-error'); setError('command-error'); setError('event-error');
  try { localStorage.setItem('chestnut.selectedBot', id); } catch { /* storage is optional */ }
  renderBots(); renderTasks(); renderDetail(); refresh();
}
function selectTask(id) {
  if (state.taskId) state.commandDrafts.set(state.taskId, $('command-text').value);
  state.taskId = id; state.commandType = 'follow_up';
  $('command-text').value = state.commandDrafts.get(id) || '';
  setError('command-error'); setError('event-error');
  renderTasks(); renderDetail(); refresh();
}
async function fetchEvents(botId, taskId) {
  const existing = state.events.get(taskId) || [];
  const after = existing.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  try {
    const incoming = await api(`${taskPath(botId, taskId)}/events?after=${after}`);
    if (!Array.isArray(incoming)) throw new Error('The server returned an invalid event list.');
    const merged = new Map(existing.map((event) => [event.seq, event]));
    incoming.forEach((event) => merged.set(event.seq, event));
    state.events.set(taskId, [...merged.values()].sort((a, b) => a.seq - b.seq));
    if (state.botId === botId && state.taskId === taskId) { setError('event-error'); renderEvents(); }
  } catch (error) {
    if (state.botId === botId && state.taskId === taskId) setError('event-error', `Activity could not refresh. ${error.message}`);
  }
}
async function refresh() {
  if (state.refreshing) { state.refreshAgain = true; return; }
  state.refreshing = true; clearTimeout(pollTimer);
  try {
    const [status, bots] = await Promise.all([api('/api/status'), api('/api/bots')]);
    if (!Array.isArray(bots)) throw new Error('The server returned an invalid bot list.');
    state.status = status; state.bots = bots; state.connected = true;
    $('connection-error').hidden = true;
    if (!bots.some((bot) => bot.id === state.botId)) {
      let remembered;
      try { remembered = localStorage.getItem('chestnut.selectedBot'); } catch { /* storage is optional */ }
      state.botId = bots.find((bot) => bot.id === remembered)?.id || bots[0]?.id || null;
      state.tasks = []; state.taskId = null; state.botRevision++; state.tasksLoaded = false;
      $('task-prompt').value = state.drafts.get(state.botId) || '';
    }
    renderStatus(); renderBots();
    if (state.botId) {
      const botId = state.botId; const revision = state.botRevision;
      const tasks = await api(botPath(botId));
      if (!Array.isArray(tasks)) throw new Error('The server returned an invalid task list.');
      if (botId === state.botId && revision === state.botRevision) {
        state.tasks = tasks; state.tasksLoaded = true;
        if (!tasks.some((task) => task.id === state.taskId)) {
          state.taskId = [...tasks].sort((a, b) => (dateValue(b.createdAt)?.getTime() || 0) - (dateValue(a.createdAt)?.getTime() || 0))[0]?.id || null;
          $('command-text').value = state.commandDrafts.get(state.taskId) || '';
        }
        renderTasks(); renderDetail();
        if (state.taskId) await fetchEvents(botId, state.taskId);
      }
    }
    renderControls();
  } catch (error) {
    state.connected = false; renderStatus();
    $('connection-error-text').textContent = error.message;
    $('connection-error').hidden = false;
  } finally {
    state.refreshing = false;
    if (state.refreshAgain) { state.refreshAgain = false; refresh(); }
    else if (!document.hidden) pollTimer = setTimeout(refresh, 2000);
  }
}
function openBotDialog() {
  if (state.busy.bot) return;
  setError('bot-form-error'); $('bot-dialog').showModal(); $('bot-name').focus();
}
$('new-bot').addEventListener('click', openBotDialog);
$('first-bot').addEventListener('click', openBotDialog);
$('close-dialog').addEventListener('click', () => $('bot-dialog').close());
$('bot-dialog').addEventListener('cancel', (event) => { if (state.busy.bot) event.preventDefault(); });
$('bot-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busy.bot) return;
  const name = $('bot-name').value.trim(); if (!name) { $('bot-name').focus(); return; }
  state.busy.bot = true; renderControls(); setError('bot-form-error');
  try {
    const bot = await post('/api/bots', { name });
    if (!bot.id) throw new Error('The server did not return the new bot. Refresh before trying again.');
    state.bots = [...state.bots.filter((entry) => entry.id !== bot.id), bot];
    $('bot-name').value = ''; $('bot-dialog').close(); selectBot(bot.id); toast(`${bot.name} is ready.`);
  } catch (error) { setError('bot-form-error', `${error.message} If the request was interrupted, close this window and check the bot list before creating another.`); }
  finally { state.busy.bot = false; renderControls(); }
});
$('task-prompt').addEventListener('input', () => { if (state.botId) state.drafts.set(state.botId, $('task-prompt').value); renderControls(); });
$('task-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busy.task || !state.botId) return;
  const prompt = $('task-prompt').value.trim(); if (!prompt) return;
  const botId = state.botId; const key = `task:${botId}`;
  const messageId = submission(key, { botId, prompt });
  state.busy.task = true; renderControls(); setError('task-form-error');
  try {
    const task = await post(botPath(botId), { messageId, prompt });
    if (!task.id) throw new Error('The server did not return the task. Your prompt is kept here so you can retry safely.');
    state.submissions.delete(key); state.drafts.delete(botId);
    if (state.botId === botId) {
      $('task-prompt').value = '';
      state.tasks = [...state.tasks.filter((entry) => entry.id !== task.id), task]; state.tasksLoaded = true;
      selectTask(task.id);
    }
    toast('Task added to the queue.'); refresh();
  } catch (error) {
    if (state.botId === botId) setError('task-form-error', `${error.message} Your prompt is kept here. Retrying the same prompt in this page reuses its message ID.`);
    else toast(`Task was not confirmed: ${error.message}`);
  } finally { state.busy.task = false; renderControls(); }
});
$('command-text').addEventListener('input', () => { if (state.taskId) state.commandDrafts.set(state.taskId, $('command-text').value); renderControls(); });
for (const tab of document.querySelectorAll('[data-command]')) tab.addEventListener('click', () => { state.commandType = tab.dataset.command; renderControls(); });
async function sendCommand(type) {
  const task = currentTask(); if (!task || state.busy.command) return;
  if (type === 'steer' && task.state !== 'running') return;
  if (type === 'follow_up' && ['cancelled', 'interrupted', 'cancelling'].includes(task.state)) return;
  if (type === 'cancel' && !['queued', 'running'].includes(task.state)) return;
  const text = type === 'cancel' ? undefined : $('command-text').value.trim(); if (type !== 'cancel' && !text) return;
  const botId = state.botId; const taskId = task.id; const key = `command:${taskId}:${type}`;
  const messageId = submission(key, { botId, taskId, type, text });
  state.busy.command = true; renderControls(); setError('command-error');
  try {
    const response = await post(`${taskPath(botId, taskId)}/commands`, { messageId, type, ...(text === undefined ? {} : { text }) });
    state.submissions.delete(key);
    if (type !== 'cancel') state.commandDrafts.delete(taskId);
    if (state.botId === botId && state.taskId === taskId && type !== 'cancel') $('command-text').value = '';
    if (type === 'follow_up') {
      const newTask = response.task || response;
      if (newTask.id && newTask.prompt !== undefined && state.botId === botId) {
        state.tasks = [...state.tasks.filter((entry) => entry.id !== newTask.id), newTask]; selectTask(newTask.id);
      }
      toast('Follow-up added as a new task.');
    } else if (type === 'steer') toast('Direction queued for the next worker boundary.');
    else {
      // Accepted cancellation is pending until a subsequent server state confirms it.
      const pending = state.tasks.find((entry) => entry.id === taskId);
      if (pending && ACTIVE.has(pending.state)) pending.state = 'cancelling';
      renderTasks(); renderDetail();
      toast('Cancellation requested. Waiting for confirmation.');
    }
    refresh();
  } catch (error) {
    if (state.botId === botId && state.taskId === taskId) setError('command-error', `${error.message} Retrying the same command in this page reuses its message ID.`);
    else toast(`Command was not confirmed: ${error.message}`);
  } finally { state.busy.command = false; renderControls(); }
}
$('command-form').addEventListener('submit', (event) => { event.preventDefault(); sendCommand(state.commandType); });
$('cancel-task').addEventListener('click', () => sendCommand('cancel'));
$('copy-task-id').addEventListener('click', async () => {
  if (!state.taskId) return;
  try { await navigator.clipboard.writeText(state.taskId); toast('Task ID copied.'); }
  catch { toast(`Task ID: ${state.taskId}`); }
});
$('retry-connection').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
for (const [inputId, formId] of [['task-prompt', 'task-form'], ['command-text', 'command-form']]) {
  $(inputId).addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $(formId).requestSubmit(); } });
}
renderControls(); refresh();
