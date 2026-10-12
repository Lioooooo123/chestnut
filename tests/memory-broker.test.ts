import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRepository, type MemoryChange } from '../src/memory/repository.ts';
import { createMemoryHandler, startMemoryBroker } from '../src/memory/broker.ts';
import { request } from 'node:http';

test('agent tools read a fixed snapshot, stamp the run source and lose access after cancellation', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chestnut-memory-broker-'));
  try {
    const repo = new MemoryRepository(join(root, 'memory')), botId = randomUUID(), taskId = randomUUID();
    const saved = repo.save(botId, { requestId: randomUUID(), title: 'Style', content: 'Use Chinese.', scope: 'personal', kind: 'preference' });
    let allowed = true; const events: unknown[] = [];
    const handle = createMemoryHandler({ repo, botId, taskId, version: saved.version, authorize: () => allowed, onEvent: (_type, data) => events.push(data) });
    const learned = handle({ action: 'save', input: { requestId: randomUUID(), title: 'Testing', content: '先写测试。', scope: 'bot', kind: 'correction' } }) as { entry: { source: string } };
    assert.equal(learned.entry.source, `chestnut://tasks/${taskId}`);
    assert.equal((handle({ action: 'search', input: { query: '测试' } }) as { entries: unknown[] }).entries.length, 0);
    assert.throws(() => handle({ action: 'save', input: { requestId: randomUUID(), title: 'No', content: 'No', scope: 'bot', kind: 'lesson', botId: randomUUID() } }), /Unsupported/);
    assert.ok(events.length > 0);
    allowed = false;
    assert.throws(() => handle({ action: 'read', input: { id: saved.id } }), /lease|cancel/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the same run loses access to write receipts and mutations when its project binding is removed', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chestnut-memory-scope-'));
  try {
    const repo = new MemoryRepository(join(root, 'memory')), botId = randomUUID(), otherBot = randomUUID();
    const settings = (id: string, project: string | null) => repo.settings(id, { requestId: randomUUID(), expectedVersion: repo.snapshot(id).version, project, enabled: true });
    settings(botId, 'fixture-project'); settings(otherBot, 'fixture-project');
    const events: unknown[] = [];
    const handle = createMemoryHandler({ repo, botId, taskId: randomUUID(), version: repo.snapshot(botId).version, authorize: () => true, onEvent: (_type, data) => events.push(data) });
    const save = { action: 'save', input: { requestId: randomUUID(), title: 'Project tests', content: 'Use unit tests.', scope: 'project', kind: 'decision' } };
    const saved = handle(save) as MemoryChange;
    const update = { action: 'update', input: { requestId: randomUUID(), id: saved.id, expectedRevision: saved.entry!.revision, title: 'Project tests', content: 'Include behavior tests.' } };
    const updated = handle(update) as MemoryChange;
    assert.equal((handle(save) as MemoryChange).replayed, true);
    assert.equal((handle(update) as MemoryChange).replayed, true);
    settings(botId, null);
    const later = repo.update(otherBot, saved.id, { requestId: randomUUID(), expectedRevision: updated.entry!.revision, title: 'Revised project tests', content: 'Use synthetic repository fixtures.' });
    const count = events.length;
    assert.throws(() => handle(save), /not found in this scope/);
    assert.throws(() => handle(update), /not found in this scope/);
    assert.throws(() => handle({ action: 'update', input: { ...update.input, requestId: randomUUID(), expectedRevision: later.entry!.revision } }), /not found in this scope/);
    assert.throws(() => handle({ action: 'forget', input: { requestId: randomUUID(), id: saved.id, expectedRevision: later.entry!.revision } }), /not found in this scope/);
    assert.throws(() => handle({ action: 'read', input: { id: saved.id } }), /not found/);
    assert.equal(events.length, count);
    assert.equal(repo.snapshot(otherBot).version, later.version);
    assert.deepEqual(repo.snapshot(otherBot).entries, [later.entry]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the private Unix broker accepts bounded tool requests and revokes a running session', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-broker-'));
  let broker: Awaited<ReturnType<typeof startMemoryBroker>> | undefined;
  try {
    const repo = new MemoryRepository(join(root, 'memory')), botId = randomUUID(); let allowed = true;
    const socketPath = join(root, 'm.sock');
    broker = await startMemoryBroker({ socketPath, repo, botId, taskId: randomUUID(), version: repo.snapshot(botId).version, authorize: () => allowed, onEvent() {} });
    const call = () => new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ action: 'search', input: { query: '' } });
      const req = request({ socketPath, method: 'POST', path: '/memory', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end(payload);
    });
    assert.equal(await call(), 200); allowed = false; assert.equal(await call(), 403);
  } finally { await broker?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('overlong Unix paths are refused before creating a listener', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-long-'));
  try {
    const repo = new MemoryRepository(join(root, 'memory')), botId = randomUUID();
    await assert.rejects(startMemoryBroker({ socketPath: join(root, 'x'.repeat(110) + '.sock'), repo, botId, taskId: randomUUID(), version: repo.snapshot(botId).version, authorize: () => true, onEvent() {} }), /too long/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
