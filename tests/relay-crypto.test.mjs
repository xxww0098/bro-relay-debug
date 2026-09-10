import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairing, parsePairing, createClient, createDevice } from '../extension/relay-crypto.js';

test('authenticated endpoints exchange concurrent, reordered messages once', async () => {
  const pairing = parsePairing(await createPairing('https://relay.example'));
  const device = await createDevice(pairing);
  const client = await createClient(pairing);
  const ready = await client.finish(await device.accept(client.hello));
  const server = await device.finish(ready.finish);
  const packets = await Promise.all(['first', 'second'].map(x => ready.session.seal(x, { command: x })));
  assert.deepEqual(await server.open(packets[1]), { requestId: 'second', payload: { command: 'second' } });
  assert.deepEqual(await server.open(packets[0]), { requestId: 'first', payload: { command: 'first' } });
  await assert.rejects(server.open(packets[0]), { code: 'replay' });
  const response = await server.seal('first', { result: 42 });
  assert.deepEqual(await ready.session.open(response), { requestId: 'first', payload: { result: 42 } });
});

async function connected(pairing) {
  pairing ??= parsePairing(await createPairing('https://relay.example'));
  const device = await createDevice(pairing), client = await createClient(pairing);
  const challenge = await device.accept(client.hello), ready = await client.finish(challenge);
  return { pairing, device, client, challenge, ready, server: await device.finish(ready.finish) };
}

test('malicious relay cannot modify headers, ciphertext, direction or session', async () => {
  const { ready, server } = await connected();
  const packet = await ready.session.seal('request', { secret: 'browser content' });
  for (const change of [{ requestId: 'forged' }, { sequence: 10 }, { direction: 'device' }, { session: 'other' }, { ciphertext: `${packet.ciphertext[0] === 'A' ? 'B' : 'A'}${packet.ciphertext.slice(1)}` }]) {
    await assert.rejects(server.open({ ...packet, ...change }));
  }
  const attempts = await Promise.allSettled([server.open(packet), server.open(packet)]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.deepEqual(attempts.find(x => x.status === 'fulfilled').value.payload, { secret: 'browser content' });
});

test('reconnect rejects old handshake and encrypted requests, independent clients work', async () => {
  const { pairing, device, client, ready, server } = await connected();
  const packet = await ready.session.seal('old', { action: 'run' });
  device.close();
  await assert.rejects(server.open(packet), { code: 'session_expired' });
  const restarted = await createDevice(pairing);
  await restarted.accept(client.hello);
  await assert.rejects(restarted.finish(ready.finish), { code: 'session_expired' });
  const next = await createClient(pairing);
  const fresh = await next.finish(await restarted.accept(next.hello));
  const freshServer = await restarted.finish(fresh.finish);
  await assert.rejects(freshServer.open(packet), { code: 'authentication_failed' });
  const other = await createClient(pairing), otherReady = await other.finish(await restarted.accept(other.hello));
  const otherServer = await restarted.finish(otherReady.finish);
  const own = await otherReady.session.seal('own', 7);
  await assert.rejects(freshServer.open(own), { code: 'authentication_failed' });
  assert.equal((await otherServer.open(own)).payload, 7);
});

test('only hub token cannot authenticate endpoints; pairing binds origin', async () => {
  const { deriveHubToken } = await import('../extension/relay-crypto.js');
  const pairing = parsePairing(await createPairing('https://relay.example'));
  const attacker = { ...pairing, secret: await deriveHubToken(pairing) };
  const device = await createDevice(pairing);
  await assert.rejects(createClient(attacker), { code: 'invalid_pairing' });
  await assert.rejects(createDevice(attacker), { code: 'invalid_pairing' });
  await assert.rejects(device.accept({ ...(await createClient(pairing)).hello, origin: 'https://evil.example' }));
  assert.throws(() => parsePairing('br-legacy-secret'), { code: 'invalid_pairing' });
});

test('replay window rejects unseen old packets and bounds concurrent handshakes', async () => {
  const { LIMITS } = await import('../extension/relay-crypto.js');
  const { pairing, ready, server } = await connected();
  const old = await ready.session.seal('old', 0);
  let newest;
  for (let i = 0; i < LIMITS.window; i++) newest = await ready.session.seal('new', i);
  assert.equal((await server.open(newest)).payload, LIMITS.window - 1);
  await assert.rejects(server.open(old), { code: 'replay' });
  const device = await createDevice(pairing), client = await createClient(pairing);
  const pending = await Promise.allSettled(Array.from({ length: LIMITS.sessions + 1 }, () => device.accept(client.hello)));
  assert.equal(pending.filter(x => x.status === 'rejected').length, 1);
  assert.equal(pending.find(x => x.status === 'rejected').reason.code, 'quota_exceeded');
});

// A private deterministic RNG in the test realm fixes the wire vector without
// allowing production callers to configure security randomness.
async function vectorSource() {
  const { readFile } = await import('node:fs/promises');
  return (await readFile(new URL('../extension/relay-crypto.js', import.meta.url), 'utf8')).replaceAll('export ', '');
}
async function runVector(source) {
  let n = 0;
  const api = new Function('crypto', `${source}; return { createPairing, parsePairing, deriveHubToken, createClient, createDevice };`)({
    subtle: crypto.subtle,
    getRandomValues(array) { array.fill(n++); return array; },
  });
  const pairing = api.parsePairing(await api.createPairing('https://relay.example'));
  const device = await api.createDevice(pairing), client = await api.createClient(pairing);
  const challenge = await device.accept(client.hello), ready = await client.finish(challenge);
  const server = await device.finish(ready.finish);
  const packet = await ready.session.seal('vector', { text: 'hello 世界' });
  const response = await server.seal('vector', { ok: true });
  assert.deepEqual(await server.open(packet), { requestId: 'vector', payload: { text: 'hello 世界' } });
  return { hubToken: await api.deriveHubToken(pairing), hello: client.hello, challenge, finish: ready.finish, packet, response };
}

test('fixed HKDF, handshake and directional AES-GCM wire vector', async () => {
  const vector = await runVector(await vectorSource());
  assert.deepEqual(vector, VECTOR);
});

const VECTOR = {
  hubToken: 'gPz62Ch0aVWwxkAPWAEBeBxg4UzgcubjMb6GvZVrxko',
  hello: { v: 2, route: '5oLVpiw7_GQPlMug', origin: 'https://relay.example', client: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' },
  challenge: { v: 2, epoch: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', nonce: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM', proof: 'hupnp52rvFNWjKBYa76JcFp07_pMIeXoInwRLMP_K-E' },
  finish: { v: 2, nonce: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM', proof: 'NxXizi2md0xvUB2nkQo2jYn-Ta9qCS9vDOJtPHfrobo' },
  packet: { session: '8T_xf2B7NXn9qwbrLbKRR6J6DT_Y794wTqgUZoS5Fks', direction: 'client', requestId: 'vector', sequence: 0, ciphertext: 'SUkZc9vhnT4t7pGN8n_wF47SrvSkXbwkCz67KLD_wiG19THQJMsQ' },
  response: { session: '8T_xf2B7NXn9qwbrLbKRR6J6DT_Y794wTqgUZoS5Fks', direction: 'device', requestId: 'vector', sequence: 0, ciphertext: '9Hho6crZPi9mw1dgejdahkdZJbdW00_Nt7d1' },
};

// Explicit browser gate, matching the repository's separate browser test run.
if (process.env.RELAY_CRYPTO_BROWSER === '1') test('Node and Chromium exchange real packets and agree on vectors', async () => {
  const { chromium } = await import('playwright');
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/relay-crypto.js', import.meta.url), 'utf8');
  const http = createServer((req, res) => { res.setHeader('Content-Type', 'text/javascript'); res.end(source); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${http.address().port}/`);
    await page.evaluate(async () => { globalThis.protocol = await import('/crypto.js'); });
    const pairing = parsePairing(await createPairing('https://relay.example'));
    const client = await createClient(pairing);
    const challenge = await page.evaluate(async ({ pairing, hello }) => {
      globalThis.device = await protocol.createDevice(pairing);
      return device.accept(hello);
    }, { pairing, hello: client.hello });
    const ready = await client.finish(challenge);
    const packet = await ready.session.seal('node', { text: 'Node → Chromium' });
    const reply = await page.evaluate(async ({ finish, packet }) => {
      globalThis.session = await device.finish(finish);
      const decoded = await session.open(packet);
      return session.seal(decoded.requestId, decoded.payload);
    }, { finish: ready.finish, packet });
    assert.deepEqual(await ready.session.open(reply), { requestId: 'node', payload: { text: 'Node → Chromium' } });
    const browserVector = await page.evaluate(async source => {
      let n = 0;
      const api = new Function('crypto', `${source}; return { createPairing, parsePairing, deriveHubToken, createClient, createDevice };`)({ subtle: crypto.subtle, getRandomValues(a) { a.fill(n++); return a; } });
      const p = api.parsePairing(await api.createPairing('https://relay.example'));
      const d = await api.createDevice(p), c = await api.createClient(p), challenge = await d.accept(c.hello), ready = await c.finish(challenge), s = await d.finish(ready.finish);
      return { hubToken: await api.deriveHubToken(p), hello: c.hello, challenge, finish: ready.finish, packet: await ready.session.seal('vector', { text: 'hello 世界' }), response: await s.seal('vector', { ok: true }) };
    }, await vectorSource());
    assert.deepEqual(browserVector, VECTOR);
  } finally { await browser?.close(); await new Promise(resolve => http.close(resolve)); }
});

test('forged proofs and reflected device proofs never establish an executable session', async () => {
  const pairing = parsePairing(await createPairing('https://relay.example'));
  const device = await createDevice(pairing), client = await createClient(pairing);
  const challenge = await device.accept(client.hello);
  await assert.rejects(client.finish({ ...challenge, proof: 'A'.repeat(43) }), { code: 'authentication_failed' });
  await assert.rejects(device.finish({ v: 2, nonce: challenge.nonce, proof: challenge.proof }), { code: 'authentication_failed' });
  await assert.rejects(device.finish({ v: 2, nonce: challenge.nonce, proof: challenge.proof }), { code: 'session_expired' });
});

test('session lookup and handshake/session deadlines fail closed', async () => {
  const { pairing, device, ready, server } = await connected();
  assert.equal(device.getSession(server.id), server);
  const packet = await ready.session.seal('expires', 'secret');
  const client = await createClient(pairing), challenge = await device.accept(client.hello);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    await assert.rejects(client.finish(challenge), { code: 'session_expired' });
    Date.now = () => realNow() + 601_000;
    await assert.rejects(server.open(packet), { code: 'session_expired' });
    assert.throws(() => device.getSession(server.id), { code: 'session_expired' });
  } finally { Date.now = realNow; }
});

test('closing sessions immediately releases their quota and rejects retained handles', async () => {
  const { LIMITS } = await import('../extension/relay-crypto.js');
  const pairing = parsePairing(await createPairing('https://relay.example'));
  const device = await createDevice(pairing);
  for (let i = 0; i <= LIMITS.sessions; i++) {
    const client = await createClient(pairing);
    const ready = await client.finish(await device.accept(client.hello));
    const server = await device.finish(ready.finish);
    const packet = await ready.session.seal('close', i);
    server.close();
    assert.throws(() => device.getSession(server.id), { code: 'session_expired' });
    await assert.rejects(server.open(packet), { code: 'session_expired' });
  }
});
