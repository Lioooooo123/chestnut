import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../src/memory/repository.ts';
test('one Git commit covers Dreaming notes, cursor, receipts; retry cannot duplicate and preferences cannot be removed', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-maint-commit-')); const bot = randomUUID(); const repo = new MemoryRepository(join(root, 'memory'));
  try {
    const input = { requestId: randomUUID(), expectedVersion: repo.snapshot(bot).version, cursor: 7, dreamAt: 1000,
      additions: [{ title: 'Test strategy', content: 'Write behavior tests first.', kind: 'lesson' as const, sourceTaskId: randomUUID() }], removals: [], conflicts: [] };
    const result = repo.applyMaintenance(bot, input); assert.equal(result.added, 1);
    const version = repo.snapshot(bot).version; const retried = new MemoryRepository(repo.path).applyMaintenance(bot, input);
    assert.equal(retried.replayed, true); assert.equal(repo.snapshot(bot).version, version); assert.equal(repo.maintenanceState(bot).cursor, 7);
    assert.throws(() => repo.applyMaintenance(bot, { ...input, requestId: randomUUID() }), /changed/);
    const pref = repo.save(bot, { requestId: randomUUID(), title: 'Style', content: 'Concise Chinese.', scope: 'bot', kind: 'preference' });
    assert.throws(() => repo.applyMaintenance(bot, { ...input, requestId: randomUUID(), expectedVersion: repo.snapshot(bot).version, additions: [], removals: [{ id: pref.id, revision: pref.entry!.revision, reason: 'transient' }] }), /protected/);
    assert.equal(repo.snapshot(bot).entries.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
