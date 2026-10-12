import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedUrl, governedFetch, isPublicAddress } from '../src/environments/network.ts';

const HOST = 'example.org';
const PUBLIC = { address: '93.184.216.34', family: 4 };
const RESPONSE = { status: 200, contentType: 'text/plain', body: 'synthetic response' };

test('governed URL requires exact allowlisted HTTPS host, no credentials or alternate ports', () => {
  assert.equal(checkedUrl('https://example.org/path?q=fixture', [HOST]).hostname, HOST);
  assert.equal(checkedUrl('https://example.org:443/path', [HOST]).port, '');
  for (const url of [
    'http://example.org/', 'https://example.org:8443/', 'https://user:password@example.org/',
    'https://sub.example.org/', 'https://example.org.evil.test/', 'https://example.org./',
    'https://127.0.0.1/', 'https://[::1]/', 'https://0x7f.1/', 'https://2130706433/',
    'file:///etc/passwd', 'data:text/plain,fixture', 'https://localhost/',
  ]) assert.throws(() => checkedUrl(url, [HOST]), /HTTPS|allowed|URL/);
  assert.throws(() => checkedUrl('https://example.org/', []), /allowed/);
  assert.throws(() => checkedUrl('https://example.org/' + 'x'.repeat(4096), [HOST]), /long/);
});

test('IP policy denies private, loopback, link-local, metadata, multicast and reserved IPv4/IPv6', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '100.127.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', '2001:db8::1', '2001:0db8::1', '2001:2::1', '2001:20::1', '2002:7f00:1::', '3fff::1',
    'invalid-address', '',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('allowed request resolves once and pins a checked address for the HTTPS transport', async () => {
  let resolutions = 0, fetches = 0;
  const value = await governedFetch('https://example.org/fixture', [HOST], () => true, {
    async resolve(host) { resolutions++; assert.equal(host, HOST); return [PUBLIC, { address: '1.1.1.1', family: 4 }]; },
    async fetch(url, address, signal) { fetches++; assert.equal(url.hostname, HOST); assert.deepEqual(address, PUBLIC); assert.equal(signal.aborted, false); return RESPONSE; },
  });
  assert.deepEqual(value, { ...RESPONSE, truncated: false }); assert.equal(resolutions, 1); assert.equal(fetches, 1);
});

test('any private DNS answer rejects the complete lookup before transport, including mixed answers', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [PUBLIC, { address: '169.254.169.254', family: 4 }], [{ address: '::ffff:10.0.0.1', family: 6 }]]) {
    let fetches = 0;
    await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, { async resolve() { return addresses; }, async fetch() { fetches++; return RESPONSE; } }), /Private|reserved/);
    assert.equal(fetches, 0);
  }
});

test('closed grant prevents DNS lookup and malformed/unallowed URLs never resolve', async () => {
  let resolutions = 0;
  const deps = { async resolve() { resolutions++; return [PUBLIC]; }, async fetch() { throw new Error('Synthetic fetch should not run'); } };
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => false, deps), /grant closed/);
  await assert.rejects(governedFetch('https://other.example/', [HOST], () => true, deps), /allowed/);
  assert.equal(resolutions, 0);
});

test('revocation during DNS lookup prevents a request to the resolved address', async () => {
  let allowed = true, fetches = 0;
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => allowed, {
    async resolve() { allowed = false; return [PUBLIC]; },
    async fetch() { fetches++; return RESPONSE; },
  }), /grant closed/);
  assert.equal(fetches, 0);
});

test('revocation during a fetch suppresses its completed response', async () => {
  let allowed = true;
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => allowed, {
    async resolve() { return [PUBLIC]; }, async fetch() { allowed = false; return RESPONSE; },
  }), /revoked/);
});

test('redirect status is returned as refusal without a second request', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, {
      async resolve() { return [PUBLIC]; }, async fetch() { calls++; return { ...RESPONSE, status }; },
    }), /Redirect refused/);
    assert.equal(calls, 1);
  }
});

test('ordinary upstream error status remains visible and is never presented as success', async () => {
  const value = await governedFetch('https://example.org/', [HOST], () => true, { async resolve() { return [PUBLIC]; }, async fetch() { return { ...RESPONSE, status: 503 }; } });
  assert.equal(value.status, 503);
});

test('DNS or transport failure propagates without a fallback destination', async () => {
  let fetches = 0;
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, { async resolve() { throw new Error('Synthetic DNS failure'); }, async fetch() { fetches++; return RESPONSE; } }), /DNS failure/);
  assert.equal(fetches, 0);
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, { async resolve() { return [PUBLIC]; }, async fetch() { throw new Error('Synthetic TLS failure'); } }), /TLS failure/);
});

test('overall deadline also bounds a never-settling DNS resolver and never dispatches transport later', async () => {
  let fetches = 0, resolveDns: (value: typeof PUBLIC[]) => void = () => {};
  const pendingDns = new Promise<typeof PUBLIC[]>(resolve => { resolveDns = resolve; });
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, {
    timeoutMs: 10,
    resolve: () => pendingDns,
    async fetch() { fetches++; return RESPONSE; },
  }), /deadline/);
  resolveDns([PUBLIC]); await Promise.resolve();
  assert.equal(fetches, 0);
});

test('overall deadline aborts a stalled transport even if its implementation ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, {
    timeoutMs: 10, async resolve() { return [PUBLIC]; },
    fetch: async (_url, _address, receivedSignal) => { signal = receivedSignal; return new Promise(() => {}); },
  }), /deadline/);
  assert.equal(signal?.aborted, true);
});

test('address family must agree with the checked DNS address', async () => {
  let fetches = 0;
  await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, {
    async resolve() { return [{ address: PUBLIC.address, family: 6 }]; }, async fetch() { fetches++; return RESPONSE; },
  }), /reserved/);
  assert.equal(fetches, 0);
});

test('returned text is explicitly truncated and remains bounded through both JSON protocol layers', async () => {
  for (const body of ['x'.repeat(128 * 1024), '\0'.repeat(128 * 1024), '中'.repeat(60000)]) {
    const value = await governedFetch('https://example.org/', [HOST], () => true, {
      async resolve() { return [PUBLIC]; }, async fetch() { return { ...RESPONSE, contentType: 'x'.repeat(1000), body }; },
    });
    assert.equal(value.truncated, true); assert.ok(Buffer.byteLength(value.body) <= 12003);
    assert.ok(value.contentType.length <= 200);
    const wireResponse = JSON.stringify({ stdout: JSON.stringify(value), stderr: '', code: 0, timedOut: false, truncated: false });
    assert.ok(Buffer.byteLength(wireResponse) < 160000);
  }
});

test('malformed transport response and invalid deadline fail closed', async () => {
  const deps = { async resolve() { return [PUBLIC]; }, async fetch() { return RESPONSE; } };
  for (const timeoutMs of [0, -1, 15001, 1.5]) await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, { ...deps, timeoutMs }), /deadline/);
  for (const response of [{ ...RESPONSE, status: 900 }, { ...RESPONSE, body: null }, { ...RESPONSE, contentType: null }]) {
    await assert.rejects(governedFetch('https://example.org/', [HOST], () => true, { ...deps, fetch: async () => response as unknown as typeof RESPONSE }), /Invalid network response/);
  }
});
