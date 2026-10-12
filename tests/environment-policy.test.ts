import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { EnvironmentPolicies, validHost, validPackage } from '../src/environments/policy.ts';
import { governedFetch } from '../src/environments/network.ts';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cn-env-policy-'));
  const store = new Store(join(root, 'fixture.sqlite'));
  const a = store.createBot('Fixture A'), b = store.createBot('Fixture B');
  return { store, a, b, policy: new EnvironmentPolicies(store), async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('per-bot environment policy is deny-by-default and cannot address an unknown bot', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.policy.get(f.a.id), { botId: f.a.id, revision: 'none', allowedPackages: [], allowedHosts: [], updatedAt: 0 });
    assert.throws(() => f.policy.get(randomUUID()), /not found/i);
    assert.equal(f.policy.stopStatus(f.a.id), null);
  } finally { await f.close(); }
});

test('policy revisions prevent stale overwrite, normalize duplicates and isolate bots', async () => {
  const f = await fixture();
  try {
    const first = f.policy.set(f.a.id, { expectedRevision: 'none', allowedPackages: ['wget', 'curl', 'curl'], allowedHosts: ['b.example', 'a.example', 'b.example'] });
    assert.deepEqual(first.allowedPackages, ['curl', 'wget']); assert.deepEqual(first.allowedHosts, ['a.example', 'b.example']);
    assert.notEqual(first.revision, 'none');
    assert.deepEqual(f.policy.get(f.b.id).allowedHosts, []);
    assert.throws(() => f.policy.set(f.a.id, { expectedRevision: 'none', allowedPackages: [], allowedHosts: [] }), /changed/);
    assert.deepEqual(f.policy.get(f.a.id), first);
    const second = f.policy.set(f.a.id, { expectedRevision: first.revision, allowedPackages: [], allowedHosts: [] });
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.allowedPackages, []); assert.deepEqual(second.allowedHosts, []);
  } finally { await f.close(); }
});

test('package and DNS policy validators reject options, paths, secrets, IPs and broad wildcards', () => {
  for (const value of ['curl', 'libstdc++6', 'python3.11']) assert.equal(validPackage(value), true);
  for (const value of ['', '--option', '/tmp/package.deb', 'https://example.org/a.deb', 'curl=1.0', 'curl;echo', 'curl\n', 'x'.repeat(81), null]) assert.equal(validPackage(value), false);
  for (const value of ['example.org', 'api.example.org', 'xn--bcher-kva.example']) assert.equal(validHost(value), true);
  for (const value of ['', '*', '*.example.org', 'https://example.org', 'example.org/path', 'USER@example.org', 'EXAMPLE.ORG', 'example.org.', 'localhost', '127.0.0.1', '[::1]', 'a..example', '-a.example', 'a-.example', 'a'.repeat(64) + '.example', null]) assert.equal(validHost(value), false);
});

test('oversized policies and invalid entries leave stored grants unchanged', async () => {
  const f = await fixture();
  try {
    const valid = { expectedRevision: 'none', allowedPackages: [] as string[], allowedHosts: [] as string[] };
    for (const input of [
      { ...valid, allowedPackages: Array(129).fill('curl') }, { ...valid, allowedHosts: Array(33).fill('example.org') },
      { ...valid, allowedPackages: ['--option'] }, { ...valid, allowedHosts: ['*.example.org'] },
    ]) assert.throws(() => f.policy.set(f.a.id, input), /Use up to/);
    assert.equal(f.policy.get(f.a.id).revision, 'none');
  } finally { await f.close(); }
});

test('policy revocation during DNS invalidates the captured revision before fetch', async () => {
  const f = await fixture();
  try {
    const snapshot = f.policy.set(f.a.id, { expectedRevision: 'none', allowedPackages: [], allowedHosts: ['example.org'] });
    let fetches = 0;
    await assert.rejects(governedFetch('https://example.org/', snapshot.allowedHosts, () => f.policy.get(f.a.id).revision === snapshot.revision, {
      async resolve() { f.policy.set(f.a.id, { expectedRevision: snapshot.revision, allowedPackages: [], allowedHosts: [] }); return [{ address: '1.1.1.1', family: 4 }]; },
      async fetch() { fetches++; return { status: 200, contentType: 'text/plain', body: 'fixture' }; },
    }), /grant closed/);
    assert.equal(fetches, 0);
  } finally { await f.close(); }
});

test('stop request is idempotent and a stale completion cannot finish a newer stop', async () => {
  const f = await fixture();
  try {
    const a = randomUUID(), b = randomUUID();
    const first = f.policy.requestStop(f.a.id, a);
    assert.equal(first.state, 'pending');
    assert.deepEqual(f.policy.requestStop(f.a.id, a), { ...first, replayed: true });
    assert.throws(() => f.policy.requestStop(f.a.id, b), /pending/);
    f.policy.finishStop(f.a.id, randomUUID()); assert.equal(f.policy.stopStatus(f.a.id)?.state, 'pending');
    f.policy.finishStop(f.a.id, a); assert.equal(f.policy.stopStatus(f.a.id)?.state, 'succeeded');
    f.policy.requestStop(f.a.id, b);
    f.policy.finishStop(f.a.id, a, 'stale completion');
    assert.equal(f.policy.stopStatus(f.a.id)?.requestId, b); assert.equal(f.policy.stopStatus(f.a.id)?.state, 'pending');
  } finally { await f.close(); }
});

test('replaying an older completed stop receipt cannot replace the newest stop or restart work', async () => {
  const f = await fixture();
  try {
    const a = randomUUID(), b = randomUUID();
    f.policy.requestStop(f.a.id, a); f.policy.finishStop(f.a.id, a);
    f.policy.requestStop(f.a.id, b); f.policy.finishStop(f.a.id, b);
    const replay = f.policy.requestStop(f.a.id, a);
    assert.equal(replay.requestId, a); assert.equal(replay.state, 'succeeded');
    assert.equal(f.policy.stopStatus(f.a.id)?.requestId, b);
    assert.deepEqual(f.policy.pendingStops(), []);
  } finally { await f.close(); }
});

test('failed stop stores a bounded error and remains a receipt instead of implicit retry', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); f.policy.requestStop(f.a.id, id); f.policy.finishStop(f.a.id, id, 'x'.repeat(2000));
    const failed = f.policy.requestStop(f.a.id, id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.length, 1000);
    assert.deepEqual(f.policy.pendingStops(), []);
    assert.throws(() => f.policy.requestStop(f.a.id, 'invalid-id'), /Invalid ID/);
  } finally { await f.close(); }
});

test('stop request identity cannot be reused for another bot', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); f.policy.requestStop(f.a.id, id);
    assert.throws(() => f.policy.requestStop(f.b.id, id), /another bot/);
    assert.equal(f.policy.stopStatus(f.b.id), null);
  } finally { await f.close(); }
});

test('package mutation intent remains durable until verified completion or explicit contained review', async () => {
  const f = await fixture();
  try {
    const run = randomUUID(), request = randomUUID();
    f.policy.beginPackage(f.a.id, run, request);
    const restarted = new EnvironmentPolicies(f.store);
    assert.equal(restarted.packageState(run)[0]?.state, 'pending');
    restarted.reviewPackages(run);
    assert.equal(restarted.packageState(run)[0]?.state, 'pending', 'uncontained changes cannot be reviewed away');
    restarted.packageNeedsReview(f.a.id, run, request, 'x'.repeat(2000));
    assert.equal(restarted.packageState(run)[0]?.state, 'needs_review');
    assert.equal(restarted.packageState(run)[0]?.reason?.length, 1000);
    restarted.containPackages(run); assert.equal(restarted.packageState(run)[0]?.state, 'contained');
    restarted.reviewPackages(run); assert.deepEqual(restarted.packageState(run), []);
    const next = randomUUID(); restarted.beginPackage(f.a.id, run, next); restarted.completePackage(next);
    assert.deepEqual(restarted.packageState(run), []);
  } finally { await f.close(); }
});
