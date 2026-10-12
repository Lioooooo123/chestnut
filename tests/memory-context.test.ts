import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryContext } from '../src/memory/context.ts';
import type { MemorySnapshot } from '../src/memory/repository.ts';

test('automatic context is bounded and selects a Chinese project lesson without injecting unrelated history', () => {
  const entry = (title: string, content: string, scope: 'personal' | 'project') => ({ id: randomUUID(), revision: randomUUID(), title, content, scope, kind: scope === 'personal' ? 'preference' as const : 'lesson' as const, botId: null, project: scope === 'project' ? 'chestnut' : null, source: 'user', createdAt: 1, updatedAt: 1 });
  const snapshot: MemorySnapshot = { version: 'a'.repeat(40), project: 'chestnut', enabled: true, writable: true, history: [], entries: [entry('沟通', '使用简洁中文段落。', 'personal'), entry('测试顺序', '先写测试再实现。', 'project'), entry('发票', '财务发票处理方法。', 'project'), ...Array.from({ length: 12 }, () => entry('其他偏好', '长'.repeat(4000), 'personal'))] };
  const context = memoryContext(snapshot, '帮我完善测试');
  assert.ok(context.entries.length <= 6);
  assert.ok(context.entries.some(note => note.title === '测试顺序'));
  assert.ok(!context.entries.some(note => note.title === '发票'));
  assert.ok(context.text.length <= 4000);
  assert.match(context.text, /reference data/);
  snapshot.entries = [{ ...entry('Communication correction', 'Explain the evidence in every reply.', 'personal'), kind: 'correction' }];
  assert.equal(memoryContext(snapshot, 'Hello').entries[0]?.content, 'Explain the evidence in every reply.');
  snapshot.entries[0]!.scope = 'bot';
  assert.equal(memoryContext(snapshot, 'Hello').entries[0]?.content, 'Explain the evidence in every reply.');
});
