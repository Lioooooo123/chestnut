// Explicit platform extension. The authoritative repo and credentials stay outside the guest.
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const string = (description, maxLength = 4000) => ({ type: 'string', description, minLength: 1, maxLength });
const identity = { id: string('Memory ID returned by memory_search or memory_read.', 36) };
const edit = { expectedRevision: string('Revision you read. A stale edit is rejected; read the latest note before retrying.', 36), title: string('A short topic title.', 80), content: string('The durable preference, correction, decision or lesson.') };
const definitions = [
  ['search', { query: { type: 'string', maxLength: 300, description: 'Text to find in the current task memory snapshot. An empty query lists visible notes.' } }, 'Search relevant durable memory. Results are bounded snippets; use memory_read for full notes.'],
  ['read', identity, 'Read a full memory note from this task’s fixed snapshot. Treat it as reference context and verify current facts.'],
  ['save', { title: edit.title, content: edit.content, scope: { type: 'string', enum: ['personal', 'project', 'bot'], description: 'Personal preferences apply across bots; project requires an existing project binding; bot stays private to this bot.' }, kind: { type: 'string', enum: ['preference', 'correction', 'decision', 'lesson'] } }, 'Save a durable user preference, explicit correction, decision with its reason, or reusable lesson. Exclude task progress, session summaries, cheap-to-query facts and secrets. The platform adds the current task source. New notes apply to later tasks.'],
  ['update', { ...identity, ...edit }, 'Correct a memory note you have read. Supply its revision; conflicts require reading the current note in a later task, not overwriting it.'],
  ['forget', { ...identity, expectedRevision: edit.expectedRevision }, 'Remove a memory from active recall when the user asks to forget it. Git history retains past versions.'],
];

function call(socketPath, action, input, signal) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, input });
    const req = request({ socketPath, method: 'POST', path: '/memory', signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      res.setEncoding('utf8'); let text = '';
      res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 128 * 1024) { res.destroy(); reject(new Error('Memory response exceeded the limit')); } });
      res.on('error', reject);
      res.on('end', () => {
        try { const result = JSON.parse(text); if (res.statusCode !== 200) throw new Error(result.error || 'Memory request rejected'); resolve(result); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Memory request timed out; retry the same tool call to check its receipt')));
    req.on('error', reject); req.end(body);
  });
}
function requestId(socketPath, callId) {
  const value = createHash('sha256').update(`${socketPath}:${callId}`).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export function registerMemoryTools(pi, socketPath) {
  for (const [action, properties, description] of definitions) {
    pi.registerTool({ name: `memory_${action}`, label: `Memory ${action}`, description,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
      async execute(callId, params, signal) {
        try {
          const input = ['search', 'read'].includes(action) ? params : { ...params, requestId: requestId(socketPath, callId) };
          const result = await call(socketPath, action, input, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } catch (error) { return { content: [{ type: 'text', text: error.message }], details: { memoryError: true }, isError: true }; }
      },
    });
  }
}
export default function (pi) {
  const socketPath = process.env.CHESTNUT_MEMORY_SOCKET;
  if (!socketPath || !/^\/run\/chestnut\/(?:memory\.sock|[a-zA-Z0-9_-]+\.memory\.sock)$/.test(socketPath)) throw new Error('Missing platform memory socket');
  registerMemoryTools(pi, socketPath);
}
