import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedVerifiedCleanup } from '../src/sandbox/verified-cleanup.ts';

test('concurrent stop callers share pending cleanup and both receive failure', async () => {
  let rejectAttempt: (error: Error) => void = () => {};
  let calls = 0;
  const stop = sharedVerifiedCleanup(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((_resolve, reject) => { rejectAttempt = reject; });
  });
  const first = stop();
  const concurrent = stop();
  assert.equal(first, concurrent);
  let finished = false;
  void concurrent.then(() => { finished = true; }, () => {});
  const firstFailure = assert.rejects(first, /daemon cleanup failed/);
  const concurrentFailure = assert.rejects(concurrent, /daemon cleanup failed/);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(finished, false);
  rejectAttempt(new Error('daemon cleanup failed'));
  await Promise.all([firstFailure, concurrentFailure]);
  assert.equal(finished, false);
  await stop(); // A new explicit attempt can prove cleanup and clear quarantine.
  assert.equal(calls, 2);
  await stop(); // Verified success is retained without repeating removal.
  assert.equal(calls, 2);
});

test('background stop plus dispose cannot report success before verified cleanup', async () => {
  let release: () => void = () => {};
  const stop = sharedVerifiedCleanup(async () => {
    await new Promise<void>(resolve => { release = resolve; });
  });
  void stop().catch(() => {});
  let disposed = false;
  const disposal = stop().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  release();
  await disposal;
  assert.equal(disposed, true);
});
