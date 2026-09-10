import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRemoteControl } from '../extension/remote-control.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  throw new Error('Condition did not settle');
}
function harness(initial = {}, storageOverride) {
  let saved = { ...initial };
  const sockets = [], requests = [];
  class Socket {
    constructor(url) { this.url = url; this.frames = []; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(data) { this.frames.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const control = createRemoteControl({
    storage: storageOverride || { get: async () => ({ ...saved }), set: async value => { saved = { ...saved, ...value }; } },
    hubUrl: 'https://relay.example.com', hello: { version: '0.1.0' },
    socketFactory: url => new Socket(url), onStop: () => {},
    onRequest: async message => { requests.push(message); return { status: 200, body: { ok: true } }; },
  });
  async function enable(rotate = false) {
    const length = sockets.length;
    const done = control.set({ enabled: true, rotate });
    await until(() => sockets.length > length);
    const ws = sockets.at(-1);
    ws.open(); ws.message({ type: 'device.authenticated' });
    return done;
  }
  return { control, sockets, requests, enable, saved: () => saved };
}

test('enable authenticates without a URL secret; off/on preserves ID and rotation revokes old socket', async t => {
  const h = harness(); t.after(() => h.control.dispose()); await h.control.ready;
  const first = await h.enable();
  assert.equal(first.connected, true);
  assert.match(first.deviceId, /^br-[\w-]{43}$/);
  const secret = first.deviceId.slice(3), old = h.sockets[0], oldMessage = old.onmessage;
  assert.equal(old.url.includes(secret), false);
  assert.equal(new URL(old.url).searchParams.get('routeId'), createHash('sha256').update(secret).digest('base64url').slice(0, 16));
  assert.deepEqual(old.frames[0], { type: 'device.auth', secret });
  old.message({ type: 'rpc.request', id: 'accepted', method: 'GET', path: '/api/tabs' });
  await tick(); assert.equal(h.requests.length, 1);
  await h.control.set({ enabled: false });
  oldMessage({ data: JSON.stringify({ type: 'rpc.request', id: 'stale' }) });
  assert.equal(h.requests.length, 1);
  assert.equal((await h.enable()).deviceId, first.deviceId);
  const rotated = await h.enable(true);
  assert.notEqual(rotated.deviceId, first.deviceId);
  assert.equal(old.readyState, 3);
  assert.equal(h.saved().remoteDeviceId, rotated.deviceId);
});

test('disable supersedes pending authentication and a stale persisted enabled read', async t => {
  const h = harness(); t.after(() => h.control.dispose()); await h.control.ready;
  const enabling = h.control.set({ enabled: true });
  await until(() => h.sockets.length === 1);
  const stale = h.sockets[0].onmessage;
  const disabled = h.control.set({ enabled: false });
  stale({ data: JSON.stringify({ type: 'device.authenticated' }) });
  await Promise.all([enabling, disabled]);
  assert.equal(h.control.status().enabled, false);
  assert.equal(h.control.isConnected(), false);
  assert.equal(h.sockets.length, 1);

  let resolveRead, first = true;
  const other = harness({}, {
    get: () => first ? (first = false, new Promise(resolve => { resolveRead = resolve; })) : Promise.resolve({}),
    set: async () => {},
  });
  t.after(() => other.control.dispose());
  await other.control.set({ enabled: false });
  resolveRead({ remoteControlEnabled: true, remoteSecret: 'old_secret', remoteRouteId: 'old_route' });
  await other.control.ready;
  assert.equal(other.control.status().enabled, false);
  assert.equal(other.sockets.length, 0);
});

test('device ping is answered without executing an RPC, and reconnect heartbeats a live socket', async t => {
  const h = harness(); t.after(() => h.control.dispose()); await h.control.ready;
  await h.enable();
  const ws = h.sockets[0];
  ws.frames.length = 0;
  ws.message({ type: 'device.ping', id: 'ping_1' });
  assert.deepEqual(ws.frames, [{ type: 'device.pong', id: 'ping_1' }]);
  assert.equal(h.requests.length, 0);

  ws.frames.length = 0;
  await h.control.reconnect();
  assert.equal(h.sockets.length, 1);
  assert.equal(ws.frames[0]?.type, 'device.hello');

  ws.send = () => { throw new Error('socket dead'); };
  const reconnecting = h.control.reconnect();
  await until(() => h.sockets.length === 2);
  h.sockets[1].open();
  h.sockets[1].message({ type: 'device.authenticated' });
  await reconnecting;
  assert.equal(h.control.isConnected(), true);
  assert.equal(h.sockets[0].readyState, 3);
});
