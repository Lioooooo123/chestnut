import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openAiMaintenanceProvider } from '../src/memory/provider.ts';
const input = { mode: 'extract' as const, tasks: [{ id: randomUUID(), createdAt: 1, user: ['Remember: Use npm.'], result: 'Done' }], entries: [], signal: new AbortController().signal };
test('outer maintenance inference uses the fixed official endpoint, bounded JSON and trusted source IDs', async () => {
  let calls = 0;
  const provider = openAiMaintenanceProvider('fake-credential', 'gpt-4o-mini', async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options!.body as string); assert.equal(body.model, 'gpt-4o-mini'); assert.equal(body.max_tokens, 2500); assert.equal(body.response_format.type, 'json_object');
    assert.match(body.messages[0].content, /untrusted/); assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ additions: [{ title: 'Manager', content: 'Use npm.', kind: 'preference', sourceTaskId: input.tasks[0]!.id, quote: 'Remember: Use npm.' }], removals: [], conflicts: [] }) } }] }));
  });
  const result = await provider(input); assert.equal(result.additions[0]?.sourceTaskId, input.tasks[0]!.id); assert.equal(calls, 1);
});
test('malformed, oversized, missing and upstream-error responses fail without leaking body or credentials', async () => {
  for (const response of [new Response('credential fake-credential', { status: 401 }), new Response('bad-json'), new Response(JSON.stringify({ choices: [] })), new Response('x'.repeat(140000))]) {
    const provider = openAiMaintenanceProvider('fake-credential', 'gpt-4o-mini', async () => response);
    await assert.rejects(provider(input), error => error instanceof Error && !error.message.includes('fake-credential'));
  }
});
