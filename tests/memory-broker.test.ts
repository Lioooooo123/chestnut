import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../src/memory/repository.ts';
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
