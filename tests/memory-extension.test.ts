import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../src/memory/repository.ts';
import { startMemoryBroker } from '../src/memory/broker.ts';

test('platform Pi tools save through the real Unix broker and repeated tool execution has one effect', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cn-extension-'));
  let broker: Awaited<ReturnType<typeof startMemoryBroker>> | undefined;
  try {
    const repo = new MemoryRepository(join(root, 'memory')), botId = randomUUID();
    const socketPath = join(root, 'm.sock');
    broker = await startMemoryBroker({ socketPath, repo, botId, taskId: randomUUID(), version: repo.snapshot(botId).version, authorize: () => true, onEvent() {} });
    const { registerMemoryTools } = await import(new URL('../src/memory/pi-extension.mjs', import.meta.url).href);
    const tools: any[] = []; registerMemoryTools({ registerTool(tool: unknown) { tools.push(tool); } }, socketPath);
    assert.deepEqual(tools.map(tool => tool.name), ['memory_search', 'memory_read', 'memory_save', 'memory_update', 'memory_forget']);
    const save = tools.find(tool => tool.name === 'memory_save');
    const params = { title: 'Testing', content: 'Write tests before implementation.', scope: 'bot', kind: 'correction' };
    const first = await save.execute('tool-call-1', params, undefined);
    const second = await save.execute('tool-call-1', params, undefined);
    assert.equal(first.isError, undefined); assert.equal(second.isError, undefined);
    assert.equal(repo.snapshot(botId).entries.length, 1);
    assert.equal(JSON.parse(second.content[0].text).replayed, true);
  } finally { await broker?.close(); rmSync(root, { recursive: true, force: true }); }
});
