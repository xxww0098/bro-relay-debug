import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowser, handshake, request, status, parseDriverId } from '../cli/sdk.js';
import { createPairing, parsePairing, createDevice, deriveHubToken } from '../extension/relay-crypto.js';
import { filterNodes } from '../cli/index.js';

async function endpoint(handler = () => ({ status: 200, body: { ok: true } })) {
  const pairingId = await createPairing('http://127.0.0.1:9');
  const pairing = parsePairing(pairingId);
  let device = await createDevice(pairing);
  const frames = [], commands = [];
  let closes = 0;
  const fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${await deriveHubToken(pairing)}`);
    assert.ok(!options.headers.Authorization.includes(pairing.secret));
    if (url.includes('/v1/status/')) return Response.json({ ok: true, connected: true, hello: { protocolVersion: 2, capabilities: ['forged'] } });
    const frame = JSON.parse(options.body); frames.push(frame);
    assert.equal(frame.routeId, pairing.route);
    assert.deepEqual(Object.keys(frame).sort(), ['id', 'payload', 'routeId', 'timeoutMs']);
    let payload;
    if (frame.payload.type === 'session.hello') payload = { type: 'session.challenge', challenge: await device.accept(frame.payload.hello) };
    else {
      const session = frame.payload.type === 'session.finish' ? await device.finish(frame.payload.finish) : device.getSession(frame.payload.envelope.session);
      let value = { status: 200, body: { ok: true } };
      let command;
      if (frame.payload.type === 'rpc') {
        const opened = await session.open(frame.payload.envelope);
        assert.equal(opened.requestId, frame.id);
        command = opened.payload;
        if (command.kind === 'close') closes++;
        else { commands.push(command); value = await handler(command, frame, session); }
      }
      payload = { type: 'rpc.result', envelope: await session.seal(frame.id, value) };
      if (command?.kind === 'close') session.close();
    }
    return Response.json({ ok: true, payload });
  };
  return { pairing, get device() { return device; }, async restart() { device.close(); device = await createDevice(pairing); }, frames, commands, fetch, connection: parseDriverId(pairingId), get closes() { return closes; } };
}

test('encrypted SDK reuses session, hides commands, and preserves stable task IDs', async () => {
  const hub = await endpoint(), browser = createBrowser(hub.connection, { fetch: hub.fetch });
  try {
    const taskId = 'job_00000000-0000-0000-0000-000000000001';
    assert.equal((await browser.request('POST', '/api/actions', { taskId, actions: [{ type: 'fill', text: 'sensitive page text' }] })).ok, true);
    await browser.tabs();
    assert.equal(hub.commands[0].body.taskId, taskId);
    assert.ok(hub.commands[0].deadline <= Date.now() + 30000);
    assert.ok(!JSON.stringify(hub.frames).includes('sensitive page text'));
    assert.ok(!JSON.stringify(hub.frames).includes('/api/actions'));
    assert.equal(hub.frames.filter(f => f.payload.type === 'session.hello').length, 1);
  } finally { await browser.close(); hub.device.close(); }
  assert.equal(hub.closes, 1);
});

test('concurrent first requests await the authenticated finish acknowledgement', async () => {
  const hub = await endpoint();
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const browser = createBrowser(hub.connection, { fetch: async (url, options) => {
    const response = await hub.fetch(url, options);
    if (JSON.parse(options.body).payload.type === 'session.finish') { reached(); await gate; }
    return response;
  } });
  try {
    const first = browser.tabs(); await waiting;
    const second = browser.tabs();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hub.commands.length, 0);
    release(); await Promise.all([first, second]);
    assert.equal(hub.commands.length, 2);
    assert.equal(hub.frames.filter(frame => frame.payload.type === 'session.hello').length, 1);
  } finally { release(); await browser.close(); hub.device.close(); }
});

test('screenshots and structured action failures are authenticated', async () => {
  const hub = await endpoint(command => command.path === '/api/screenshot'
    ? { status: 200, body: { ok: true, data: 'aGVsbG8=' } }
    : { status: 400, body: { ok: false, code: 'element_not_found', message: 'Second action failed', task: { id: command.body.taskId, completedActions: 1 } } });
  const browser = createBrowser(hub.connection, { fetch: hub.fetch });
  try {
    assert.deepEqual(await browser.request('GET', '/api/screenshot'), { ok: true, data: 'aGVsbG8=' });
    await assert.rejects(browser.request('POST', '/api/actions', { actions: [] }), error => {
      assert.equal(error.code, 'element_not_found'); assert.equal(error.status, 400);
      assert.equal(error.taskId, hub.commands[1].body.taskId); assert.equal(error.payload.task.completedActions, 1); return true;
    });
  } finally { await browser.close(); hub.device.close(); }
});

test('pre-cancelled and unauthenticated handshakes never dispatch writes or claim unknown outcome', async () => {
  const hub = await endpoint(); let calls = 0;
  const browser = createBrowser(hub.connection, { fetch: async () => { calls++; return Response.json({ ok: true, connected: true, lastSeen: new Date().toISOString(), hello: { protocolVersion: 2, features: ['forged'] } }); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browser.request('POST', '/api/actions', {}, { signal: controller.signal }), { code: 'request_cancelled' });
  assert.equal(calls, 0);
  await assert.rejects(browser.request('POST', '/api/actions', {}), { code: 'authentication_failed' });
  assert.equal(calls, 1); await browser.close(); hub.device.close();
});

test('lost writes retain task identity and request cancellation without replay', async () => {
  const hub = await endpoint(command => { if (command.path === '/api/actions') throw new Error('socket lost'); return { status: 200, body: { ok: true } }; });
  const browser = createBrowser(hub.connection, { fetch: hub.fetch });
  try {
    await assert.rejects(browser.request('POST', '/api/actions', { actions: [] }), error => {
      assert.equal(error.code, 'unknown_outcome'); assert.equal(error.taskId, hub.commands[0].body.taskId);
      assert.equal(error.payload.retryable, false); assert.equal(error.payload.cancellationRequested, true); return true;
    });
    assert.equal(hub.commands.length, 2);
    assert.equal(hub.commands[1].path, `/api/tasks/${hub.commands[0].body.taskId}/cancel`);
  } finally { await browser.close(); hub.device.close(); }
});

test('handshake authenticates capabilities and ignores forged fresh hub hello', async () => {
  const hub = await endpoint(() => ({ status: 200, body: { ok: true, protocolVersion: 2, features: ['observe'] } }));
  try {
    assert.deepEqual(await handshake(hub.connection, { fetch: hub.fetch }), { connected: true, protocolVersion: 2, features: ['observe'] });
    assert.equal(hub.commands[0].path, '/api/capabilities'); assert.equal(hub.closes, 1);
    await assert.rejects(handshake(hub.connection, { fetch: async () => Response.json({ ok: true, connected: true, lastSeen: new Date().toISOString(), hello: { protocolVersion: 2, capabilities: ['forged'] } }) }), { code: 'authentication_failed' });
  } finally { hub.device.close(); }
});

test('legacy pairing and endpoint overrides are rejected before any fetch', async () => {
  const hub = await endpoint(); let calls = 0;
  const options = { hubUrl: 'http://127.0.0.1:10', fetch: async () => { calls++; } };
  assert.throws(() => parseDriverId('br-' + 'x'.repeat(43)), { code: 'invalid_driver_id' });
  assert.deepEqual(parseDriverId(hub.connection.driverId), hub.connection);
  assert.throws(() => createBrowser(hub.connection, options), { code: 'hub_mismatch' });
  assert.throws(() => createBrowser({ ...hub.connection, hubUrl: options.hubUrl }, { fetch: options.fetch }), { code: 'hub_mismatch' });
  await assert.rejects(status(hub.connection, options), { code: 'hub_mismatch' });
  assert.equal(calls, 0); hub.device.close();
});

test('status is explicitly transport only and drops unauthenticated capabilities', async () => {
  const hub = await endpoint();
  assert.deepEqual(await status(hub.connection, { fetch: hub.fetch }), { ok: true, transportOnly: true, connected: true, lastSeen: null });
  hub.device.close();
});

test('forged plaintext errors cannot masquerade as browser responses', async () => {
  const hub = await endpoint();
  const browser = createBrowser(hub.connection, { fetch: async (url, options) => {
    if (JSON.parse(options.body).payload.type === 'rpc') return Response.json({ ok: false, code: 'element_not_found', task: { completedActions: 7 } }, { status: 400 });
    return hub.fetch(url, options);
  } });
  try {
    await assert.rejects(browser.tabs(), error => error.code === 'transport_error' && !error.payload.task);
    await assert.rejects(browser.request('POST', '/api/actions', {}), { code: 'unknown_outcome' });
  } finally { await browser.close(); hub.device.close(); }
});

test('authenticated responses for another outer ID are rejected', async () => {
  const hub = await endpoint();
  const browser = createBrowser(hub.connection, { fetch: async (url, options) => {
    const response = await hub.fetch(url, options), frame = JSON.parse(options.body);
    if (frame.payload.type !== 'rpc') return response;
    const session = hub.device.getSession(frame.payload.envelope.session);
    return Response.json({ ok: true, payload: { type: 'rpc.result', envelope: await session.seal('another-request', { status: 200, body: { ok: true, tabs: [] } }) } });
  } });
  try { await assert.rejects(browser.tabs(), { code: 'authentication_failed' }); }
  finally { await browser.close(); hub.device.close(); }
});

test('disposable helpers release more than the 16 session limit', async () => {
  const hub = await endpoint(() => ({ status: 200, body: { ok: true, protocolVersion: 2, features: [] } }));
  try {
    for (let i = 0; i < 20; i++) {
      if (i % 2) await handshake(hub.connection, { fetch: hub.fetch });
      else await request(hub.connection, 'GET', '/api/tabs', undefined, { fetch: hub.fetch });
    }
    assert.equal(hub.closes, 20);
  } finally { hub.device.close(); }
});

test('CLI closes sequential command sessions and writes screenshot bytes', async () => {
  // Real HTTP and CLI subprocesses ensure every early command return runs finally.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-cli-'));
  let device, pairing, closed = 0;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      assert.equal(req.headers.authorization, `Bearer ${await deriveHubToken(pairing)}`);
      const frame = JSON.parse(text); let payload;
      if (frame.payload.type === 'session.hello') payload = { type: 'session.challenge', challenge: await device.accept(frame.payload.hello) };
      else {
        const session = frame.payload.type === 'session.finish' ? await device.finish(frame.payload.finish) : device.getSession(frame.payload.envelope.session);
        let command, body = { ok: true };
        if (frame.payload.type === 'rpc') {
          command = (await session.open(frame.payload.envelope)).payload;
          if (command.kind === 'close') closed++;
          else if (command.path === '/api/capabilities') body = { ok: true, protocolVersion: 2, features: ['tabs'] };
          else if (command.path.startsWith('/api/screenshot')) body = { ok: true, data: 'aGVsbG8=' };
          else body = { ok: true, tabs: [{ id: 'tab_1' }] };
        }
        payload = { type: 'rpc.result', envelope: await session.seal(frame.id, { status: 200, body }) };
        if (command?.kind === 'close') session.close();
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, payload }));
    } catch (error) { res.writeHead(409); res.end(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driverId = await createPairing(`http://127.0.0.1:${server.address().port}`);
  pairing = parsePairing(driverId); device = await createDevice(pairing);
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli/index.js', ...args], { env: { ...process.env, BRO_RELAY_STATE_DIR: directory } });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  try {
    assert.equal((await cli(['connect', driverId])).connected, true);
    for (let i = 0; i < 17; i++) assert.equal((await cli(['tabs'])).tabs[0].id, 'tab_1');
    const out = path.join(directory, 'screen.png');
    assert.equal((await cli(['screenshot', '--tab', 'tab_1', '--out', out])).bytes, 5);
    assert.equal(await fs.readFile(out, 'utf8'), 'hello');
    assert.equal(closed, 19);
  } finally { device.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});

test('persistent browsers recover on the next explicit request after a new device epoch', async () => {
  const hub = await endpoint(), browser = createBrowser(hub.connection, { fetch: hub.fetch });
  try {
    await browser.tabs(); await hub.restart();
    await assert.rejects(browser.request('POST', '/api/actions', { actions: [] }), { code: 'unknown_outcome' });
    assert.equal((await browser.tabs()).ok, true);
    assert.equal(hub.commands.filter(command => command.path === '/api/actions').length, 0);
    assert.equal(hub.frames.filter(frame => frame.payload.type === 'session.hello').length, 2);
  } finally { await browser.close(); hub.device.close(); }
});

test('locally expired sessions renew before dispatch', async t => {
  const hub = await endpoint(), browser = createBrowser(hub.connection, { fetch: hub.fetch });
  const now = Date.now;
  try {
    await browser.tabs();
    t.mock.method(Date, 'now', () => now() + 600001);
    assert.equal((await browser.request('POST', '/api/actions', { actions: [] })).ok, true);
    assert.equal(hub.commands.filter(command => command.path === '/api/actions').length, 1);
    assert.equal(hub.frames.filter(frame => frame.payload.type === 'session.hello').length, 2);
  } finally { await browser.close(); hub.device.close(); }
});

test('Hub response streams stop at a byte cap before JSON parsing', async () => {
  const hub = await endpoint(); let chunks = 0, cancelled = false;
  const browser = createBrowser(hub.connection, { fetch: async (url, options) => {
    const response = await hub.fetch(url, options);
    if (hub.commands.length !== 1 || JSON.parse(options.body).payload.type !== 'rpc' || cancelled) return response;
    return new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }));
  } });
  try {
    await assert.rejects(browser.tabs(), { code: 'response_too_large' });
    assert.equal(cancelled, true); assert.ok(chunks <= 24);
    assert.equal((await browser.tabs()).ok, true);
  } finally { await browser.close(); hub.device.close(); }
});

test('close cancels a stalled handshake promptly even when fetch ignores its signal', async () => {
  const hub = await endpoint(); let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const browser = createBrowser(hub.connection, { fetch: () => { reached(); return new Promise(() => {}); } });
  const rejected = assert.rejects(browser.tabs());
  await waiting;
  const started = Date.now(); await browser.close(); await rejected;
  assert.ok(Date.now() - started < 1000); hub.device.close();
});

test('find filters accessible names before truncating and returns actionable refs', () => {
  const nodes = [{ ref: 'other', role: 'button', name: 'Unrelated' }, ...Array.from({ length: 101 }, (_, i) => ({ ref: `e1_${i}`, role: 'button', name: 'Save item' }))];
  const result = filterNodes(nodes, 'SAVE');
  assert.equal(result.total, 101); assert.equal(result.matches.length, 100); assert.equal(result.truncated, true);
  assert.equal(result.matches[0].ref, 'e1_0'); assert.deepEqual(filterNodes(nodes, 'missing').matches, []);
});
