import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { config } from '../src/config.ts';
import { MemoryRepository } from '../src/memory/repository.ts';
import { MemoryMaintenance, type MaintenanceProvider } from '../src/memory/maintenance.ts';
function fixture(provider?: MaintenanceProvider) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-maint-'));
  const c = config({ CHESTNUT_DATA_DIR: root });
  const store = new Store(join(root, 'db.sqlite')); const bot = store.createBot('Memory');
  const repo = new MemoryRepository(join(root, 'control', 'memory'));
  const maintenance = new MemoryMaintenance(store, c, provider);
  const finish = (prompt: string) => { const task = store.submit(bot.id, randomUUID(), prompt); const run = store.claim(randomUUID())!; store.finish(run, 'succeeded', 'Verified result.', null); return task; };
  return { root, c, store, bot, repo, maintenance, finish, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('automatic explicit memories persist with source, incremental cursor and no duplicate after restart', async () => {
  const f = fixture();
  try {
    const task = f.finish('记住：先写行为测试，再实现功能。');
    await f.maintenance.tick();
    const snapshot = f.repo.snapshot(f.bot.id);
    assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0]?.content, '先写行为测试，再实现功能。');
    assert.equal(snapshot.entries[0]?.scope, 'bot'); assert.equal(snapshot.entries[0]?.origin, 'automatic');
    assert.equal(snapshot.entries[0]?.source, `chestnut://tasks/${task.id}`);
    assert.ok(f.repo.maintenanceState(f.bot.id).cursor > 0);
    await new MemoryMaintenance(f.store, f.c).tick();
    assert.equal(f.repo.snapshot(f.bot.id).version, snapshot.version);
  } finally { f.close(); }
});
test('Dreaming runs after use, preserves preferences, consolidates automatic duplicates and waits a day', async () => {
  const f = fixture();
  try {
    const explicit = f.repo.save(f.bot.id, { requestId: randomUUID(), title: 'Style', content: 'Answer in Chinese.', scope: 'bot', kind: 'preference' });
    f.finish('Remember: Use npm for this project.'); await f.maintenance.tick();
    const before = f.repo.snapshot(f.bot.id); assert.equal(before.entries.length, 2);
    const progress = f.repo.maintenanceState(f.bot.id); assert.ok(progress.lastDreamAt > 0);
    await f.maintenance.tick(); assert.equal(f.repo.snapshot(f.bot.id).version, before.version);
    f.maintenance.requestDream(f.bot.id, randomUUID()); await f.maintenance.tick();
    assert.ok(f.repo.maintenanceState(f.bot.id).lastDreamAt >= progress.lastDreamAt);
    assert.equal(f.repo.snapshot(f.bot.id).entries.find(e => e.id === explicit.id)?.revision, explicit.entry?.revision);
    assert.equal(f.maintenance.status(f.bot.id).state, 'succeeded');
  } finally { f.close(); }
});
test('forgotten sources cannot be paraphrased back and disabled memory does not call the provider', async () => {
  let calls = 0;
  const f = fixture(async input => { calls++; return { additions: input.tasks.map(t => ({ title: 'Preference', content: 'Use behavior tests before coding.', kind: 'preference', sourceTaskId: t.id, quote: t.user[0]! })), removals: [], conflicts: [] }; });
  try {
    f.finish('Remember: Tests first.'); await f.maintenance.tick();
    const note = f.repo.snapshot(f.bot.id).entries[0]!;
    f.repo.forget(f.bot.id, note.id, { requestId: randomUUID(), expectedRevision: note.revision });
    f.maintenance.requestDream(f.bot.id, randomUUID()); await f.maintenance.tick();
    assert.equal(f.repo.snapshot(f.bot.id).entries.length, 0);
    const count = calls;
    f.repo.settings(f.bot.id, { requestId: randomUUID(), expectedVersion: f.repo.snapshot(f.bot.id).version, project: null, enabled: false });
    f.finish('Remember: No memory.'); await f.maintenance.tick(); assert.equal(calls, count);
  } finally { f.close(); }
});
test('bad provenance and destructive Dreaming plans fail atomically without advancing the cursor', async () => {
  let destructive = false;
  const f = fixture(async input => ({ additions: [{ title: 'Made up', content: 'Invented fact.', kind: 'lesson', sourceTaskId: input.tasks[0]!.id, quote: 'Not in this conversation' }], removals: destructive ? [{ id: input.entries[0]!.id, revision: input.entries[0]!.revision, reason: 'transient' }] : [], conflicts: [] }));
  try {
    const saved = f.repo.save(f.bot.id, { requestId: randomUUID(), title: 'Explicit', content: 'Preserve this.', scope: 'bot', kind: 'lesson' });
    f.finish('A normal task.'); await f.maintenance.tick();
    assert.equal(f.maintenance.status(f.bot.id).state, 'failed'); assert.equal(f.repo.maintenanceState(f.bot.id).cursor, 0);
    assert.equal(f.repo.snapshot(f.bot.id).entries.length, 1);
    destructive = true; f.maintenance.requestDream(f.bot.id, randomUUID()); await f.maintenance.tick();
    assert.equal(f.repo.snapshot(f.bot.id).entries[0]?.revision, saved.entry?.revision);
  } finally { f.close(); }
});
test('a stale inference cannot overwrite edits or commit after memory is disabled', async () => {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  const f = fixture(async input => { entered(); await waiting; return { additions: [{ title: 'Style', content: 'Use Chinese.', kind: 'preference', sourceTaskId: input.tasks[0]!.id, quote: input.tasks[0]!.user[0]! }], removals: [], conflicts: [] }; });
  try {
    f.finish('Remember: Use Chinese.'); const work = f.maintenance.tick(); await started;
    f.repo.settings(f.bot.id, { requestId: randomUUID(), expectedVersion: f.repo.snapshot(f.bot.id).version, project: null, enabled: false });
    release(); await work;
    assert.equal(f.repo.maintenanceState(f.bot.id).cursor, 0); assert.equal(f.repo.snapshot(f.bot.id).entries.length, 0);
  } finally { f.close(); }
});
test('two schedulers cannot infer the same batch concurrently and retries have bounded budgets', async () => {
  let release!: () => void; let entered!: () => void; let calls = 0;
  const waiting = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  const f = fixture(async () => { calls++; entered(); await waiting; throw new Error('offline'); });
  try {
    f.finish('Remember: Use npm.'); const work = f.maintenance.tick(); await started;
    await new MemoryMaintenance(f.store, f.c, async () => { calls++; throw new Error('Must not run'); }).tick();
    assert.equal(calls, 1); release(); await work;
    await f.maintenance.tick(); assert.equal(calls, 1);
    assert.equal(f.maintenance.status(f.bot.id).state, 'failed');
  } finally { f.close(); }
});
test('dirty memory is preserved and maintenance reports a recoverable blocked state', async () => {
  const f = fixture();
  try { f.finish('Remember: Use npm.'); writeFileSync(join(f.repo.path, 'MEMORY.md'), 'Local edit'); await f.maintenance.tick();
    assert.equal(f.maintenance.status(f.bot.id).state, 'blocked'); assert.equal(f.repo.maintenanceState(f.bot.id).cursor, 0);
  } finally { f.close(); }
});
test('contradictions remain inspectable proposals instead of replacing existing preferences', async () => {
  const f = fixture(async input => ({ additions: [], removals: [], conflicts: [{ title: 'Package manager conflict', content: 'User now requests bun; existing memory says npm.', sourceTaskId: input.tasks[0]!.id, quote: input.tasks[0]!.user[0]! }] }));
  try { const saved = f.repo.save(f.bot.id, { requestId: randomUUID(), title: 'Manager', content: 'Use npm.', scope: 'bot', kind: 'preference' });
    f.finish('Remember: Use bun.'); await f.maintenance.tick();
    assert.equal(f.repo.snapshot(f.bot.id).entries[0]?.revision, saved.entry?.revision);
    const proposal = f.repo.maintenanceState(f.bot.id).conflicts[0]!; assert.match(proposal.content, /bun/);
    f.repo.dismissConflict(f.bot.id, proposal.id, randomUUID()); assert.equal(f.repo.maintenanceState(f.bot.id).conflicts.length, 0);
  } finally { f.close(); }
});
test('credentials and ordinary task progress are never turned into automatic memory', async () => {
  const f = fixture();
  try { f.finish('Remember: password=super-secret-demo'); await f.maintenance.tick(); f.finish('Build completed; deployed yesterday.'); await f.maintenance.tick();
    assert.equal(f.repo.snapshot(f.bot.id).entries.length, 0);
  } finally { f.close(); }
});
test('daily budget and automatic-off configuration defer work while an explicit request can run', async () => {
  const f = fixture();
  try {
    const disabled = new MemoryMaintenance(f.store,{...f.c,memoryAutomatic:false});
    f.finish('Remember: Use npm.'); await disabled.tick(); assert.equal(f.repo.maintenanceState(f.bot.id).cursor,0);
    disabled.requestDream(f.bot.id,randomUUID()); await disabled.tick(); assert.equal(f.repo.snapshot(f.bot.id).entries.length,1);
    f.store.db.prepare('UPDATE memory_budget SET calls=24').run(); f.finish('Remember: Use behavior tests.'); await f.maintenance.tick();
    assert.equal(f.maintenance.status(f.bot.id).state,'failed'); assert.match(f.maintenance.status(f.bot.id).error ?? '',/budget/);
    assert.equal(f.repo.snapshot(f.bot.id).entries.length,1);
  } finally { f.close(); }
});
test('an unused bot does not keep spending daily Dreaming budget', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { additions: [], removals: [], conflicts: [] }; });
  try { f.finish('A task with no durable memory.'); await f.maintenance.tick(); const version = f.repo.snapshot(f.bot.id).version;
    await f.maintenance.tick(Date.now()+2*86400000); assert.equal(calls,1); assert.equal(f.repo.snapshot(f.bot.id).version,version);
  } finally { f.close(); }
});
test('a committed manual Dreaming result is recovered without replaying inference after lost ledger acknowledgment', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { additions: [], removals: [], conflicts: [] }; });
  try { f.finish('A task.'); await f.maintenance.tick(); const request = randomUUID(); f.maintenance.requestDream(f.bot.id,request); await f.maintenance.tick();
    const version = f.repo.snapshot(f.bot.id).version; const count = calls;
    f.store.db.prepare("UPDATE memory_jobs SET requested=?,lastRequest=NULL,state='running',token=?,leaseUntil=0 WHERE botId=?").run(request,randomUUID(),f.bot.id);
    await new MemoryMaintenance(f.store,f.c,async () => { calls++; throw new Error('Must not infer again'); }).tick();
    assert.equal(calls,count); assert.equal(f.repo.snapshot(f.bot.id).version,version); assert.equal(f.maintenance.status(f.bot.id).state,'succeeded'); assert.equal(f.maintenance.status(f.bot.id).requested,null);
  } finally { f.close(); }
});
