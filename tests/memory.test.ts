import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryRepository } from '../src/memory/repository.ts';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'chestnut-memory-'));
  const path = join(root, 'memory');
  return { root, path, repo: new MemoryRepository(path), botId: randomUUID(), close() { rmSync(root, { recursive: true, force: true }); } };
}

test('a saved preference has a source and Git version, and survives a new repository instance', () => {
  const f = fixture();
  try {
    const saved = f.repo.save(f.botId, { requestId: randomUUID(), title: 'Reply style', content: '请使用简洁中文段落：说明事实、依据与不确定性。', scope: 'personal', kind: 'preference' });
    const reopened = new MemoryRepository(f.path).snapshot(f.botId);
    assert.equal(reopened.entries[0]?.content, '请使用简洁中文段落：说明事实、依据与不确定性。');
    assert.equal(reopened.entries[0]?.source, 'user');
    assert.match(saved.version, /^[a-f0-9]{40}$/);
    const index = execFileSync('git', ['-C', f.path, 'show', `${saved.version}:MEMORY.md`], { encoding: 'utf8' });
    assert.match(index, /\[\[notes\//);
    assert.equal(reopened.history[0]?.action, 'save');
  } finally { f.close(); }
});

test('retries do not duplicate memory and a stale correction cannot overwrite a newer one', () => {
  const f = fixture();
  try {
    const input = { requestId: randomUUID(), title: 'Package manager', content: 'Use npm.', scope: 'personal' as const, kind: 'preference' as const };
    const saved = f.repo.save(f.botId, input);
    assert.equal(f.repo.save(f.botId, input).version, saved.version);
    assert.throws(() => f.repo.save(f.botId, { ...input, content: 'Use bun.' }), /different content/);
    const correction = { requestId: randomUUID(), expectedRevision: saved.entry!.revision, title: input.title, content: 'Use bun.' };
    const changed = f.repo.update(f.botId, saved.id, correction);
    assert.equal(f.repo.update(f.botId, saved.id, correction).version, changed.version);
    assert.throws(() => f.repo.update(f.botId, saved.id, { ...correction, requestId: randomUUID(), content: 'Use yarn.' }), /changed/);
    assert.equal(f.repo.snapshot(f.botId).entries[0]?.content, 'Use bun.');
    assert.equal(f.repo.snapshot(f.botId, '', saved.version).entries[0]?.content, 'Use npm.');
  } finally { f.close(); }
});

test('forget removes active content and rejects an agent trying to recreate it after restart', () => {
  const f = fixture();
  try {
    const input = { requestId: randomUUID(), title: 'Old preference', content: 'Use npm.', scope: 'personal' as const, kind: 'preference' as const };
    const saved = f.repo.save(f.botId, input);
    const forgotten = f.repo.forget(f.botId, saved.id, { requestId: randomUUID(), expectedRevision: saved.entry!.revision });
    assert.equal(forgotten.forgotten, true);
    const reopened = new MemoryRepository(f.path);
    assert.equal(reopened.snapshot(f.botId).entries.length, 0);
    assert.equal(reopened.snapshot(f.botId, '', saved.version).entries.length, 0);
    assert.throws(() => reopened.save(f.botId, { ...input, requestId: randomUUID(), content: '  USE  npm. ' }, 'agent'), /forgotten/);
    assert.equal(reopened.save(f.botId, { ...input, requestId: randomUUID() }).entry?.content, 'Use npm.');
  } finally { f.close(); }
});

test('personal preferences are shared while bot and project lessons remain scoped and memory can be turned off', () => {
  const f = fixture(); const other = randomUUID();
  const settings = (botId: string, project: string | null, enabled = true) => f.repo.settings(botId, { requestId: randomUUID(), expectedVersion: f.repo.snapshot(botId).version, project, enabled });
  try {
    settings(f.botId, 'chestnut'); settings(other, 'poppoint');
    f.repo.save(f.botId, { requestId: randomUUID(), title: 'Style', content: 'Answer in Chinese.', scope: 'personal', kind: 'preference' });
    f.repo.save(f.botId, { requestId: randomUUID(), title: 'Bot detail', content: 'Only this bot knows this.', scope: 'bot', kind: 'lesson' });
    f.repo.save(f.botId, { requestId: randomUUID(), title: 'Project detail', content: 'Use rootless Docker here.', scope: 'project', kind: 'decision' });
    assert.equal(f.repo.snapshot(other).entries.length, 1);
    settings(other, 'chestnut'); assert.equal(f.repo.snapshot(other).entries.length, 2);
    assert.equal(f.repo.snapshot(f.botId, 'rootless').entries[0]?.title, 'Project detail');
    settings(f.botId, 'chestnut', false);
    assert.equal(f.repo.snapshot(other).entries.length, 0);
    assert.throws(() => f.repo.save(f.botId, { requestId: randomUUID(), title: 'No', content: 'Must not save.', scope: 'personal', kind: 'lesson' }), /turned off/);
    settings(f.botId, 'chestnut'); assert.equal(f.repo.snapshot(f.botId).entries.length, 3);
  } finally { f.close(); }
});

test('uncommitted edits are kept for inspection and never become readable memory or silently committed', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.path, 'MEMORY.md'), 'Uncommitted interruption');
    const snapshot = f.repo.snapshot(f.botId); assert.equal(snapshot.writable, false);
    assert.throws(() => f.repo.save(f.botId, { requestId: randomUUID(), title: 'No', content: 'Do not commit pending edits.', scope: 'personal', kind: 'lesson' }), /uncommitted/);
    assert.equal(execFileSync('git', ['-C', f.path, 'show', 'HEAD:MEMORY.md'], { encoding: 'utf8' }).includes('Uncommitted interruption'), false);
  } finally { f.close(); }
});
