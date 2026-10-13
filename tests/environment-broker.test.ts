import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEnvironmentHandler } from '../src/environments/broker.ts';

const result = { stdout: 'fixture', stderr: '', code: 0, timedOut: false, truncated: false };
type Handler = ReturnType<typeof createEnvironmentHandler>;
/** In-memory HTTP-shaped streams, never a listener or socket. */
async function request(broker: Handler, input: unknown, overrides: { method?: string; url?: string; contentType?: string; raw?: string; parts?: string[] } = {}) {
  const req = Readable.from(overrides.parts ?? [overrides.raw ?? JSON.stringify(input)]) as unknown as IncomingMessage;
  req.method = overrides.method ?? 'POST'; req.url = overrides.url ?? '/environment'; req.headers = { 'content-type': overrides.contentType ?? 'application/json' };
  const response = { headersSent: false, status: 0, value: undefined as any, writeHead(status: number) { this.status = status; this.headersSent = true; return this; }, end(body?: string) { this.value = body ? JSON.parse(body) : undefined; return this; } };
  await broker.handler(req, response as unknown as ServerResponse);
  return response;
}
function input(command = 'printf fixture') { return { requestId: randomUUID(), command }; }

test('computer input shares receipts and revocation; unknown dispatch cannot be replayed',async()=>{
  let allowed=true,calls=0;const computer={op:'type',text:'fixture only'},body={requestId:randomUUID(),action:'computer',computer};
  const broker=createEnvironmentHandler({socketPath:'/unused',authorize:()=>allowed,environment:{async execute(){return result;}},computer:async()=>{calls++;return {sessionId:randomUUID(),png:'fixture-header-only'};}});
  assert.equal((await request(broker,body)).status,200);assert.equal((await request(broker,body)).status,200);assert.equal(calls,1);assert.equal((await request(broker,{...body,computer:{op:'click',x:1,y:1}})).status,409);allowed=false;assert.equal((await request(broker,body)).status,403);await broker.close();
  let attempts=0;const uncertain=createEnvironmentHandler({socketPath:'/unused',authorize:()=>true,environment:{async execute(){return result;}},computer:async()=>{attempts++;throw new Error('lost screenshot after click');}});assert.equal((await request(uncertain,body)).status,502);assert.equal((await request(uncertain,body)).status,409);assert.equal(attempts,1);assert.equal(uncertain.isHealthy(),false);await uncertain.close();
});

test('bounded environment command runs once and an identical request reuses its receipt', async () => {
  let calls = 0; const events: string[] = [];
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; return result; } }, onEvent: type => events.push(type) });
  const body = input();
  assert.deepEqual((await request(broker, body)).value, result);
  assert.deepEqual((await request(broker, body)).value, result);
  assert.equal(calls, 1); assert.equal(broker.isHealthy(), true);
  assert.equal((await request(broker, { ...body, command: 'different fixture' })).status, 409);
  assert.deepEqual(events, ['environment.command.started', 'environment.command.finished']);
  await broker.close();
});

test('broker validates routes, schema, request IDs and byte/timeout limits without dispatch', async () => {
  let calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; return result; } } });
  assert.equal((await request(broker, input(), { method: 'GET' })).status, 404);
  assert.equal((await request(broker, input(), { url: '/other' })).status, 404);
  assert.equal((await request(broker, input(), { contentType: 'text/plain' })).status, 415);
  assert.equal((await request(broker, null, { raw: '{' })).status, 400);
  assert.equal((await request(broker, null, { parts: ['x'.repeat(40000), 'x'.repeat(40000)] })).status, 413);
  for (const value of [null, [], { ...input(), requestId: 'not-a-uuid' }, { ...input(), extra: true }, input(''), input(' '), input('x'.repeat(60001)), input('中'.repeat(20001)), { ...input(), timeoutMs: 99 }, { ...input(), timeoutMs: 90001 }, { ...input(), timeoutMs: 1.5 }]) {
    assert.equal((await request(broker, value)).status, 400);
  }
  assert.equal(calls, 0); await broker.close();
});

test('revocation forbids dispatch and access to prior successful receipts', async () => {
  let allowed = true, calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => allowed, environment: { async execute() { calls++; return result; } } });
  const body = input(); assert.equal((await request(broker, body)).status, 200);
  allowed = false;
  assert.equal((await request(broker, body)).status, 403);
  assert.equal((await request(broker, input())).status, 403);
  assert.equal(calls, 1); await broker.close();
});

test('pending command blocks concurrent commands and cannot be replayed', async () => {
  let finish: (value: typeof result) => void = () => {}, started: () => void = () => {};
  const begun = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<typeof result>(resolve => { finish = resolve; });
  let calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; started(); return pending; } } });
  const body = input(), first = request(broker, body); await begun;
  assert.equal(broker.isIdle(), false); assert.equal(broker.isHealthy(), false);
  assert.equal((await request(broker, body)).status, 409);
  assert.equal((await request(broker, input())).status, 409);
  assert.equal(calls, 1); finish(result);
  assert.equal((await first).status, 200); assert.equal(broker.isHealthy(), true);
  await broker.close();
});

test('transport error or timeout permanently marks this task uncertain and denies new commands', async () => {
  for (const timedOut of [false, true]) {
    let calls = 0;
    const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; if (timedOut) return { ...result, code: null, timedOut: true }; throw new Error('fixture lost result'); } } });
    const body = input();
    assert.equal((await request(broker, body)).status, timedOut ? 409 : 502);
    assert.equal(broker.isIdle(), true); assert.equal(broker.isHealthy(), false);
    assert.equal((await request(broker, body)).status, 409);
    assert.equal((await request(broker, input())).status, 409);
    assert.equal(calls, 1); await broker.close();
  }
});

test('known nonzero command exit is a settled result rather than uncertain transport', async () => {
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { return { ...result, code: 1 }; } } });
  assert.equal((await request(broker, input())).value.code, 1);
  assert.equal(broker.isHealthy(), true); await broker.close();
});

test('close revokes immediately and waits for an outstanding command before returning', async () => {
  let finish: (value: typeof result) => void = () => {}, started: () => void = () => {};
  const begun = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<typeof result>(resolve => { finish = resolve; });
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { started(); return pending; } } });
  const first = request(broker, input()); await begun;
  let drained = false; const close = broker.close().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal((await request(broker, input())).status, 403);
  finish(result); await close;
  assert.equal((await first).status, 403);
  assert.equal(broker.isIdle(), true); assert.equal(broker.isHealthy(), false);
});

test('revocation while a command is executing suppresses its response and marks uncertainty', async () => {
  let allowed = true;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => allowed, environment: { async execute() { allowed = false; return result; } } });
  assert.equal((await request(broker, input())).status, 403);
  assert.equal(broker.isHealthy(), false); await broker.close();
});

test('receipt payload memory is bounded per task and existing completed receipts remain readable', async () => {
  let calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; return { ...result, stdout: 'x'.repeat(65536), stderr: 'x'.repeat(65536) }; } } });
  const first = input(); assert.equal((await request(broker, first)).status, 200);
  let status = 200;
  for (let i = 0; i < 20 && status === 200; i++) status = (await request(broker, input())).status;
  assert.equal(status, 429); assert.ok(calls <= 17);
  assert.equal((await request(broker, first)).status, 200);
  assert.equal(broker.isHealthy(), true); await broker.close();
});

test('request count is bounded independently of output size', async () => {
  let calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; return { ...result, stdout: '' }; } } });
  for (let i = 0; i < 1000; i++) assert.equal((await request(broker, input())).status, 200);
  assert.equal((await request(broker, input())).status, 429);
  assert.equal(calls, 1000); await broker.close();
});

test('package and network operations are disabled when no explicit policy-backed provider exists', async () => {
  let calls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { calls++; return result; } } });
  assert.equal((await request(broker, { requestId: randomUUID(), action: 'packages', packages: ['curl'] })).status, 403);
  assert.equal((await request(broker, { requestId: randomUUID(), action: 'fetch', url: 'https://example.org/' })).status, 403);
  assert.equal(calls, 0); assert.equal(broker.isHealthy(), true); await broker.close();
});

test('package requests accept only bounded package names and reuse the same installation receipt', async () => {
  const installs: Array<{ packages: string[]; requestId: string }> = [];
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { throw new Error('Shell fallback forbidden'); } }, installPackages: async (packages, requestId) => { installs.push({ packages, requestId }); return { installed: packages }; } });
  for (const packages of [[], ['--option'], ['https://example.org/a.deb'], ['/tmp/a.deb'], ['pkg=version'], ['pkg;echo'], ['x'.repeat(81)], Array(17).fill('curl')]) {
    assert.equal((await request(broker, { requestId: randomUUID(), action: 'packages', packages })).status, 400);
  }
  const body = { requestId: randomUUID(), action: 'packages', packages: ['curl', 'libstdc++6'] };
  assert.equal((await request(broker, body)).status, 200);
  assert.equal((await request(broker, body)).status, 200);
  assert.deepEqual(installs, [{ packages: body.packages, requestId: body.requestId }]);
  assert.equal((await request(broker, { ...body, action: 'execute', command: 'fixture', packages: undefined })).status, 409);
  await broker.close();
});

test('failed package operation is uncertain and cannot be automatically replayed or followed by shell work', async () => {
  let installs = 0, shellCalls = 0;
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { shellCalls++; return result; } }, installPackages: async () => { installs++; throw new Error('Fixture partial package change'); } });
  const body = { requestId: randomUUID(), action: 'packages', packages: ['curl'] };
  assert.equal((await request(broker, body)).status, 502);
  assert.equal((await request(broker, body)).status, 409);
  assert.equal((await request(broker, input())).status, 409);
  assert.equal(installs, 1); assert.equal(shellCalls, 0); assert.equal(broker.isHealthy(), false);
  await broker.close();
});

test('governed fetch receives only a URL and cannot reuse another action receipt', async () => {
  const urls: string[] = [];
  const broker = createEnvironmentHandler({ socketPath: '/unused', authorize: () => true, environment: { async execute() { return result; } }, fetchUrl: async url => { urls.push(url); return { status: 200, body: 'fixture' }; } });
  const body = { requestId: randomUUID(), action: 'fetch', url: 'https://example.org/fixture' };
  assert.equal((await request(broker, { ...body, headers: { authorization: 'fixture' } })).status, 400);
  assert.equal((await request(broker, { ...body, url: 'x'.repeat(4097) })).status, 400);
  assert.equal((await request(broker, body)).status, 200);
  assert.equal((await request(broker, { requestId: body.requestId, command: 'fixture' })).status, 409);
  assert.deepEqual(urls, [body.url]);
  await broker.close();
});
