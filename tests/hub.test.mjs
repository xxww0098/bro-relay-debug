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
