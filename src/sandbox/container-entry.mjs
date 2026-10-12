// Runs only inside the rootless, network-none container. No real credentials.
import { createServer, request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const model = process.env.CHESTNUT_MODEL;
const sessionPath = process.argv[2];
if (!model || !sessionPath?.startsWith('/session/') || sessionPath.includes('..')) throw new Error('Missing sandbox configuration');
const relay = createServer((incoming, outgoing) => {
  if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
    outgoing.writeHead(403); outgoing.end('Route not allowed'); return;
  }
  const upstream = request({ socketPath: '/run/chestnut/model.sock', path: incoming.url, method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    outgoing.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
    response.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Model gateway unavailable'); });
  incoming.on('aborted', () => upstream.destroy());
  outgoing.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
});
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(4011, '127.0.0.1', resolve); });
await mkdir('/tmp/pi-agent', { recursive: true, mode: 0o700 });
await mkdir('/tmp/home', { recursive: true, mode: 0o700 });
await writeFile('/tmp/pi-agent/models.json', JSON.stringify({ providers: { chestnut: {
  baseUrl: 'http://127.0.0.1:4011/v1', api: 'openai-completions', apiKey: 'chestnut-local-no-secret',
  models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false } }],
} } }), { mode: 0o600 });
const child = spawn('node', [
  '/opt/pi/packages/coding-agent/dist/bundle/rpc-entry.js', '--provider', 'chestnut', '--model', model,
  '--session', sessionPath, '--session-dir', '/session',
  '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
], { stdio: 'inherit', shell: false });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { relay.close(); process.exitCode = 1; });
child.on('exit', code => { relay.close(); process.exitCode = code ?? 1; });
