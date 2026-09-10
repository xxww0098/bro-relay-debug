import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BrowserRelayDevice } from '../hub/src/worker.js';
import { sendRpc } from '../hub/src/rpc.js';

const secret = 'test_secret_with_sufficient_entropy';
const routeId = createHash('sha256').update(secret).digest('base64url').slice(0, 16);

test('hub only claims the secret-derived route and does not accept another socket response', async () => {
  const device = new BrowserRelayDevice({}, {});
  assert.equal((await device.authorize(secret, { routeId })).code, 'remote_device_offline');
  const [wrong, right] = await Promise.all([
    device.authorize('other_secret_with_sufficient_entropy', { routeId, claim: true }),
    device.authorize(secret, { routeId, claim: true }),
  ]);
  assert.equal(wrong.ok, false);
  assert.equal(right.ok, true);
  device.deviceSocket = {};
  device.handleDeviceMessage({}, JSON.stringify({ type: 'device.hello', version: 'untrusted' }));
  assert.equal(device.hello, null);
  device.handleDeviceMessage(device.deviceSocket, JSON.stringify({ type: 'device.hello', version: '0.1.0' }));
  assert.equal(device.hello.version, '0.1.0');
  device.handleDeviceClose({});
  assert.notEqual(device.deviceSocket, null);
  device.handleDeviceClose(device.deviceSocket);
  assert.equal(device.deviceSocket, null);
});

test('losing an action request cancels its exact task and forbids automatic replay', async () => {
  const frames = [];
  const pending = new Map();
  const signal = new AbortController();
  const result = sendRpc({ send: (frame) => frames.push(JSON.parse(frame)) }, pending,
    { id: 'request1', method: 'POST', path: '/api/actions', body: { actions: [{ type: 'click' }] } },
    { signal: signal.signal });
  signal.abort();
  await assert.rejects(result, error => {
    assert.equal(error.retryable, false);
    assert.equal(error.taskId, frames[0].body.taskId);
    assert.equal(error.cancellationRequested, true);
    return true;
  });
  assert.equal(frames[1].path, `/api/tasks/${frames[0].body.taskId}/cancel`);
  assert.equal(pending.size, 0);
});

function rpcRequest(body) {
  return new Request('https://device.local/v1/rpc', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeId, method: 'GET', path: '/api/capabilities', ...body }),
  });
}

test('a stale open socket is probed and dropped instead of waiting for the RPC timeout', async () => {
  const device = new BrowserRelayDevice({}, {});
  await device.authorize(secret, { routeId, claim: true });
  const sent = [];
  device.pingTimeoutMs = 30;
  device.staleMs = 22_000;
  device.deviceSocket = {
    readyState: 1,
    send(frame) { sent.push(JSON.parse(frame)); },
    close() { device.handleDeviceClose(this); },
  };
  device.lastSeen = new Date(Date.now() - 60_000).toISOString();
  const started = Date.now();
  const response = await device.handleRpc(rpcRequest());
  const body = await response.json();
  assert.equal(body.code, 'remote_device_offline');
  assert.equal(body.retryable, true);
  assert.ok(Date.now() - started < 1000, `fail-fast took ${Date.now() - started}ms`);
  assert.equal(sent[0]?.type, 'device.ping');
  assert.equal(sent.some(frame => frame.type === 'rpc.request'), false);
  assert.equal(device.deviceSocket, null);
});

test('a stale socket that answers ping still receives the original RPC', async () => {
  const device = new BrowserRelayDevice({}, {});
  await device.authorize(secret, { routeId, claim: true });
  const sent = [];
  const socket = {
    readyState: 1,
    send(frame) {
      const msg = JSON.parse(frame);
      sent.push(msg);
      if (msg.type === 'device.ping') {
        queueMicrotask(() => device.handleDeviceMessage(socket, JSON.stringify({ type: 'device.pong', id: msg.id })));
      }
      if (msg.type === 'rpc.request') {
        queueMicrotask(() => device.handleDeviceMessage(socket, JSON.stringify({
          type: 'rpc.response', id: msg.id, status: 200, body: { ok: true, protocolVersion: 2 },
        })));
      }
    },
    close() { device.handleDeviceClose(this); },
  };
  device.deviceSocket = socket;
  device.lastSeen = new Date(Date.now() - 60_000).toISOString();
  const response = await device.handleRpc(rpcRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, protocolVersion: 2 });
  assert.equal(sent[0]?.type, 'device.ping');
  assert.equal(sent[1]?.type, 'rpc.request');
  assert.equal(device.deviceSocket, socket);
});

test('a freshly seen socket skips the ping and forwards the RPC', async () => {
  const device = new BrowserRelayDevice({}, {});
  await device.authorize(secret, { routeId, claim: true });
  const sent = [];
  const socket = {
    readyState: 1,
    send(frame) {
      const msg = JSON.parse(frame);
      sent.push(msg);
      if (msg.type === 'rpc.request') {
        queueMicrotask(() => device.handleDeviceMessage(socket, JSON.stringify({
          type: 'rpc.response', id: msg.id, status: 200, body: { ok: true },
        })));
      }
    },
  };
  device.deviceSocket = socket;
  device.lastSeen = new Date().toISOString();
  const response = await device.handleRpc(rpcRequest());
  assert.equal(response.status, 200);
  assert.equal(sent[0]?.type, 'rpc.request');
  assert.equal(sent.some(frame => frame.type === 'device.ping'), false);
});
