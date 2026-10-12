import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type Server, type RequestOptions } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { mkdtemp, lstat, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { startModelGateway, createGatewayHttpServer, type ModelGatewayOptions } from '../src/gateway/index.ts';

const model = 'test-configured-model';
const apiKey = 'sk-trusted-host-only-secret';
const valid = { model, messages: [{ role: 'user', content: 'hello' }] };

type Result = { status: number; headers: IncomingMessage['headers']; text: string };
const memoryServers = new Map<string, Server>();
let memoryServerId = 0;
class MemorySocket extends Duplex {
  peer!: MemorySocket;
  connecting = false;
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.peer.push(chunk);
    callback();
  }
  _final(callback: () => void) { this.peer.push(null); callback(); }
  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (!this.peer.destroyed) this.peer.destroy();
    callback(error);
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
function request(options: RequestOptions, callback?: (res: IncomingMessage) => void) {
  const server = options.socketPath ? memoryServers.get(options.socketPath) : undefined;
  if (!server) return httpRequest(options, callback);
  const client = new MemorySocket();
  const host = new MemorySocket();
  client.peer = host;
  host.peer = client;
  server.emit('connection', host);
  return httpRequest({ ...options, agent: undefined, createConnection: () => client as unknown as Socket }, callback);
}
async function fixture(t: TestContext, overrides: Partial<ModelGatewayOptions> = {}) {
  const socketPath = `memory-${++memoryServerId}`;
  const gateway = createGatewayHttpServer({
    model, apiKey,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: 'hello' } }] }),
    ...overrides,
  });
  memoryServers.set(socketPath, gateway.server);
  t.after(async () => { await gateway.close(); memoryServers.delete(socketPath); });
  return { gateway, socketPath };
}
function call(socketPath: string, body: unknown = valid, options: {
  path?: string; method?: string; headers?: Record<string, string>; raw?: string;
} = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path: options.path ?? '/v1/chat/completions', method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(options.raw ?? JSON.stringify(body));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('forwards only fixed endpoint with trusted credentials and configured limits', async (t) => {
  const forwarded: { url: string; init: RequestInit }[] = [];
  const { socketPath } = await fixture(t, { fetchImpl: async (url, init) => {
    forwarded.push({ url: String(url), init: init! });
    return Response.json({ choices: [] }, { headers: { authorization: apiKey, 'set-cookie': 'secret=true' } });
  } });
  const result = await call(socketPath, { ...valid, max_tokens: 100000 }, {
    headers: { authorization: 'Bearer attacker-value', host: 'attacker.example', 'x-api-key': 'attacker-value' },
  });
  assert.equal(result.status, 200);
  assert.equal(forwarded[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(forwarded[0].init.redirect, 'error');
  const headers = new Headers(forwarded[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${apiKey}`);
  assert.equal(headers.get('host'), null);
  assert.equal(headers.get('x-api-key'), null);
  const body = JSON.parse(String(forwarded[0].init.body));
  assert.equal(body.model, model);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.n, 1);
  assert.equal(body.store, false);
  assert.ok(!JSON.stringify(body).includes(apiKey));
  assert.equal(result.headers.authorization, undefined);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.ok(!result.text.includes(apiKey));
});

test('defaults max_completion_tokens, honors lower limit and configured cap', async (t) => {
  const forwarded: Record<string, unknown>[] = [];
  const { socketPath } = await fixture(t, { maxOutputTokens: 200, fetchImpl: async (_url, init) => {
    forwarded.push(JSON.parse(String(init!.body)));
    return Response.json({});
  } });
  await call(socketPath);
  await call(socketPath, { ...valid, max_completion_tokens: 20 });
  await call(socketPath, { ...valid, max_completion_tokens: 500 });
  assert.deepEqual(forwarded.map((body) => body.max_completion_tokens), [200, 20, 200]);
});

test('blocks wrong paths, methods, content types and invalid or overbroad requests', async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, { fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal((await call(socketPath, valid, { path: '/v1/responses' })).status, 404);
  assert.equal((await call(socketPath, valid, { path: '/v1/chat/completions?url=evil' })).status, 404);
  assert.equal((await call(socketPath, valid, { path: 'https://attacker.example/v1/chat/completions' })).status, 404);
  assert.equal((await call(socketPath, valid, { method: 'GET' })).status, 404);
  assert.equal((await call(socketPath, valid, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(socketPath, valid, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await call(socketPath, valid, { raw: '{bad json' })).status, 400);
  const invalid = [
    [], null, { ...valid, model: 'other' }, { ...valid, messages: [] },
    { ...valid, webhook: 'https://attacker.example' }, { ...valid, base_url: 'https://attacker.example' },
    { ...valid, store: true }, { ...valid, metadata: { authorization: 'spoof' } },
    { ...valid, stream: 'true' }, { ...valid, n: 2 }, { ...valid, max_tokens: -1 },
    { ...valid, max_tokens: 0 }, { ...valid, max_tokens: '10' }, { ...valid, max_tokens: 1.1 },
    { ...valid, max_tokens: 100, max_completion_tokens: 100 },
    { ...valid, stream_options: { include_usage: true, webhook: 'https://attacker.example' } },
    { ...valid, tools: [{ type: 'web_search' }] },
    { ...valid, tools: [{ type: 'function', function: { name: 'read', url: 'https://attacker.example' } }] },
    { ...valid, tool_choice: { type: 'web_search' } },
    { ...valid, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://attacker.example' } }] }] },
    { ...valid, messages: [{ role: 'user', content: 'hello', webhook: 'https://attacker.example' }] },
  ];
  for (const body of invalid) assert.equal((await call(socketPath, body)).status, 400, JSON.stringify(body));
  assert.equal(calls, 0);
});

test('allows text parts and function tools/tool-call history', async (t) => {
  const { socketPath } = await fixture(t);
  const result = await call(socketPath, {
    model,
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Read a file.' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'A README' },
    ],
    tools: [{ type: 'function', function: { name: 'read', description: 'Read a local file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } }],
    tool_choice: 'auto', parallel_tool_calls: true, store: false,
  });
  assert.equal(result.status, 200);
});

test('caps request bodies at 2 MiB, including chunked uploads', async (t) => {
  let calls = 0;
  const { socketPath } = await fixture(t, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const oversized = JSON.stringify({ ...valid, messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] });
  assert.equal((await call(socketPath, valid, { raw: oversized, headers: { 'content-length': String(Buffer.byteLength(oversized)) } })).status, 413);
  assert.equal((await call(socketPath, valid, { raw: oversized, headers: { 'transfer-encoding': 'chunked' } })).status, 413);
  assert.equal(calls, 0);
});

test('streams SSE before upstream completion and redacts key across chunks', async (t) => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const { socketPath } = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { source = controller; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const responseReady = deferred<IncomingMessage>();
  const req = request({ socketPath, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, responseReady.resolve);
  req.end(JSON.stringify({ ...valid, stream: true, stream_options: { include_usage: true } }));
  const response = await responseReady.promise;
  assert.match(response.headers['content-type']!, /text\/event-stream/);
  const chunks: string[] = [];
  response.on('data', (chunk) => chunks.push(chunk.toString()));
  const firstChunk = once(response, 'data');
  source.enqueue(Buffer.from('data: {"delta":"first"}\n\n'));
  await firstChunk;
  assert.equal(chunks.join(''), 'data: {"delta":"first"}\n\n');
  const end = once(response, 'end');
  source.enqueue(Buffer.from(`data: {"delta":"${apiKey.slice(0, 10)}`));
  source.enqueue(Buffer.from(`${apiKey.slice(10)}"}\n\ndata: [DONE]\n\n`));
  source.close();
  await end;
  assert.ok(chunks.join('').includes('[REDACTED]'));
  assert.ok(!chunks.join('').includes(apiKey));
  assert.ok(chunks.join('').endsWith('data: [DONE]\n\n'));
});

test('never forwards upstream error bodies or exception details', async (t) => {
  let throwing = false;
  const { socketPath } = await fixture(t, { fetchImpl: async () => {
    if (throwing) throw new Error(`network error for ${apiKey}`);
    return new Response(`Invalid key: ${apiKey}`, { status: 401 });
  } });
  const denied = await call(socketPath);
  assert.equal(denied.status, 401);
  assert.ok(!denied.text.includes(apiKey));
  assert.ok(!denied.text.includes('Invalid key'));
  throwing = true;
  const failed = await call(socketPath);
  assert.equal(failed.status, 502);
  assert.ok(!failed.text.includes(apiKey));
});

test('allows at most two concurrent upstream requests and recovers slots', async (t) => {
  const started = deferred<void>();
  const release = deferred<void>();
  let count = 0;
  const { socketPath } = await fixture(t, { fetchImpl: async () => {
    count++;
    if (count === 2) started.resolve();
    await release.promise;
    return Response.json({});
  } });
  const a = call(socketPath);
  const b = call(socketPath);
  await started.promise;
  assert.equal((await call(socketPath)).status, 429);
  assert.equal(count, 2);
  release.resolve();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  assert.equal((await call(socketPath)).status, 200);
});

test('aborts upstream fetch when the downstream disconnects', async (t) => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const { socketPath } = await fixture(t, { fetchImpl: async (_url, init) => {
    started.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted.resolve(); reject(new Error('aborted')); }, { once: true });
    });
  } });
  const req = request({ socketPath, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify(valid));
  await started.promise;
  req.destroy();
  await aborted.promise;
});

test('enforces a request timeout without exposing upstream details', async (t) => {
  const { socketPath } = await fixture(t, { requestTimeoutMs: 30, fetchImpl: async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(`timeout ${apiKey}`)), { once: true });
    });
  } });
  const result = await call(socketPath);
  assert.equal(result.status, 504);
  assert.ok(!result.text.includes(apiKey));
});

test('Unix socket integration: private modes and idempotent cleanup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'chestnut-gateway-'));
  const socketPath = join(directory, 'model.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let gateway;
  try { gateway = await startModelGateway({ socketPath, model, apiKey }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('This executor forbids binding Unix sockets; HTTP behavior is tested in memory.');
      return;
    }
    throw error;
  }
  t.after(() => gateway.close());
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  assert.ok((await lstat(socketPath)).isSocket());
  await gateway.close();
  await gateway.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('rejects existing files, socket symlinks, parent symlinks, and nonprivate directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'chestnut-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const existingPath = join(directory, 'existing.sock');
  await writeFile(existingPath, 'do not delete');
  await assert.rejects(startModelGateway({ socketPath: existingPath, apiKey, model }), /already exists/);
  assert.equal(await readFile(existingPath, 'utf8'), 'do not delete');
  const target = join(directory, 'target');
  await mkdir(target, { mode: 0o700 });
  const linked = join(directory, 'linked');
  await symlink(target, linked);
  await assert.rejects(startModelGateway({ socketPath: join(linked, 'model.sock'), apiKey, model }), /symlink/);
  const insecure = join(directory, 'insecure');
  await mkdir(insecure, { mode: 0o755 });
  await assert.rejects(startModelGateway({ socketPath: join(insecure, 'model.sock'), apiKey, model }), /0700/);
  await symlink(existingPath, join(directory, 'symlink.sock'));
  await assert.rejects(startModelGateway({ socketPath: join(directory, 'symlink.sock'), apiKey, model }), /already exists/);
});

test('rejects untrusted upstream URLs before opening any listener', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'chestnut-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const upstreamBaseUrl of [
    'http://api.openai.com/v1', 'https://api.openai.com.evil.example/v1',
    'https://api.openai.com@evil.example/v1', 'https://api.openai.com/v1?url=evil',
    'https://api.openai.com/v2', 'http://127.0.0.1:8080/v1', 'https://example.com/v1',
  ]) {
    await assert.rejects(startModelGateway({ socketPath: join(directory, 'model.sock'), apiKey, model, upstreamBaseUrl }), /official OpenAI/);
  }
  await assert.rejects(startModelGateway({ socketPath: 'relative/model.sock', apiKey, model }), /absolute path/);
});
test('trusted run fence denies revoked model capability before any provider call',async(t)=>{
  let allowed=false,calls=0;
  const {socketPath}=await fixture(t,{authorize:()=>allowed,fetchImpl:async()=>{calls++;return Response.json({choices:[]});}});
  assert.equal((await call(socketPath)).status,403);assert.equal(calls,0);
  allowed=true;assert.equal((await call(socketPath)).status,200);assert.equal(calls,1);
  allowed=false;assert.equal((await call(socketPath)).status,403);assert.equal(calls,1);
});
test('too-long Unix socket path fails with an actionable error before binding',async()=>{
  await assert.rejects(startModelGateway({socketPath:`/tmp/${'x'.repeat(104)}/model.sock`,apiKey,model}),/shorter CHESTNUT_DATA_DIR/);
});
test('ChatGPT Responses gateway refreshes outer credentials and strips unsupported plan fields',async t=>{
  let sent:any;let keyCalls=0;
  const f=await fixture(t,{apiProtocol:'responses',getApiKey:async()=>{keyCalls++;return 'oauth-secret-live';},fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(new Headers(options!.headers).get('authorization'),'Bearer oauth-secret-live');sent=JSON.parse(options!.body as string);return new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});}});
  const response=await call(f.socketPath,{model,stream:true,store:false,max_output_tokens:4096,input:[{role:'user',content:[{type:'input_text',text:'hello'}]}],tools:[{type:'function',name:'memory_search',parameters:{type:'object',properties:{}}}]},{path:'/v1/responses'});
  assert.equal(response.status,200);assert.equal(keyCalls,1);assert.equal(sent.max_output_tokens,undefined);assert.equal(sent.store,false);assert.equal(sent.tools[0].type,'namespace');assert.match(response.text,/response.completed/);
});
test('Responses denies hosted tools, external content, previous response references and nonstream requests before credentials',async t=>{
  let calls=0;const f=await fixture(t,{apiProtocol:'responses',getApiKey:async()=>{calls++;return 'oauth-secret';}});
  const good={model,stream:true,store:false,input:[{role:'user',content:'hello'}]};
  for(const changed of [{...good,stream:false},{...good,store:true},{...good,previous_response_id:'other'},{...good,tools:[{type:'web_search'}]},{...good,input:[{type:'item_reference',id:'other'}]},{...good,input:[{role:'user',content:[{type:'input_image',image_url:'https://outside.invalid/'}]}]}])assert.equal((await call(f.socketPath,changed,{path:'/v1/responses'})).status,400);
  assert.equal(calls,0);
});
