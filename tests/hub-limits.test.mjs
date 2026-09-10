import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BrowserRelayDevice } from '../hub/src/worker.js';

test('chunked UTF-8 input is rejected by byte budget before the stream ends', async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) { if (++pulls > 4) controller.error(new Error('read beyond budget')); else controller.enqueue(new TextEncoder().encode('界'.repeat(24_000))); },
    cancel() { cancelled = true; },
  });
  const response = await worker.fetch(new Request('https://hub.local/v1/rpc', {
    method: 'POST', body, duplex: 'half',
  }), {});
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'request_body_too_large');
  assert.equal(cancelled, true);
});

test('pending exhaustion rejects immediately and disconnect releases every slot', async () => {
  const device = new BrowserRelayDevice({}, {});
  const socket = { readyState: 1, send() {} };
  device.deviceSocket = socket;
  device.lastSeen = new Date().toISOString();
  const pending = Array.from({ length: 32 }, () => device.sendRpcToDevice({ method: 'GET', path: '/api/tabs' }).catch(error => error));
  const extra = device.sendRpcToDevice({ method: 'GET', path: '/api/tabs' });
  setTimeout(() => device.handleDeviceClose(socket), 20);
  await assert.rejects(extra, { code: 'remote_device_busy' });
  assert.ok((await Promise.all(pending)).every(error => error.code === 'remote_device_offline'));
  device.deviceSocket = socket;
  const next = device.sendRpcToDevice({ method: 'GET', path: '/api/tabs' });
  device.handleDeviceClose(socket);
  await assert.rejects(next, { code: 'remote_device_offline' });
});

function sockets(t) {
  const original = globalThis.Response;
  const all = [];
  class Socket extends EventTarget {
    readyState = 1;
    frames = [];
    accept() {}
    send(data) { this.frames.push(JSON.parse(data)); }
    close(code) { this.code = code; this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  }
  t.mock.method(globalThis, 'Response', function (body, init) {
    return init?.status === 101 ? { status: 101, webSocket: init.webSocket } : new original(body, init);
  });
  const oldPair = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class {
    constructor() { this[0] = new Socket(); this[1] = new Socket(); all.push(this[1]); }
  };
  t.after(() => { for (const socket of all) socket.close(1000); globalThis.WebSocketPair = oldPair; });
  return all;
}

async function connect(device) {
  return device.fetch(new Request('https://hub.local/v1/device/connect?routeId=0123456789abcdef', {
    headers: { Upgrade: 'websocket' },
  }));
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('authentication is bounded, releases closed slots, and cannot resurrect a closed socket', async t => {
  const all = sockets(t);
  const device = new BrowserRelayDevice({}, {});
  for (let i = 0; i < 10; i++) assert.equal((await connect(device)).status, 101);
  assert.equal((await connect(device)).status, 429);
  all[0].close(1000);
  await turn();
  assert.equal((await connect(device)).status, 101);
  const socket = all.at(-1);
  let finish, authorizations = 0;
  device.authorize = () => { authorizations++; return new Promise(resolve => { finish = resolve; }); };
  socket.message(JSON.stringify({ type: 'device.auth', secret: 'secret' }));
  socket.message(JSON.stringify({ type: 'device.auth', secret: 'secret' }));
  assert.equal(authorizations, 1);
  socket.close(1000);
  finish({ ok: true });
  await turn();
  assert.equal(socket.frames.length, 0);
  assert.equal(device.deviceSocket, null);
});

test('replacement rejects old pending requests and oversized responses fail explicitly', async t => {
  const all = sockets(t);
  const device = new BrowserRelayDevice({}, {});
  device.authorize = async () => ({ ok: true });
  await connect(device);
  all[0].message(JSON.stringify({ type: 'device.auth', secret: 'secret' }));
  await turn();
  const pending = device.sendRpcToDevice({ method: 'POST', path: '/api/actions', body: {} }).catch(error => error);
  await connect(device);
  all[1].message(JSON.stringify({ type: 'device.auth', secret: 'secret' }));
  await turn();
  assert.equal((await pending).retryable, false);
  assert.equal(all[0].code, 4001);
  const screenshot = device.sendRpcToDevice({ method: 'GET', path: '/api/screenshot' });
  all[1].message(' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(screenshot, { code: 'response_body_too_large', status: 413 });
  assert.equal(all[1].code, 1009);
  assert.equal(device.deviceSocket, null);
});

test('authentication timeout releases capacity and an oversized auth frame never reaches authentication', async t => {
  const all = sockets(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new BrowserRelayDevice({}, {});
  for (let i = 0; i < 10; i++) await connect(device);
  t.mock.timers.tick(5000);
  assert.ok(all.every(socket => socket.code === 4008));
  assert.equal((await connect(device)).status, 101);
  let called = false;
  device.authorize = async () => { called = true; return { ok: true }; };
  all.at(-1).message(JSON.stringify({ type: 'device.auth', secret: 'x'.repeat(128 * 1024) }));
  await turn();
  assert.equal(called, false);
  assert.equal(all.at(-1).code, 1009);
});

test('an unfinished request body expires and cancels its stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const response = worker.fetch(new Request('https://hub.local/v1/rpc', {
    method: 'POST', duplex: 'half', body: new ReadableStream({ cancel() { cancelled = true; } }),
  }), {});
  t.mock.timers.tick(30_000);
  assert.equal((await response).status, 408);
  assert.equal(cancelled, true);
});
