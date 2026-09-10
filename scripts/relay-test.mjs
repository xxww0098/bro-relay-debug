import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRemoteControl } from '../extension/remote-control.js';
import { createBrowser } from '../cli/sdk.js';

const origin = process.argv[2] || 'http://localhost:18797';
const saved = {};
let dispatched = 0;
const sockets = [];
const remote = createRemoteControl({
  hubUrl: origin,
  socketFactory: url => { const socket = new WebSocket(url); sockets.push(socket); return socket; },
  storage: { get: async () => ({ ...saved }), set: async values => Object.assign(saved, values), remove: async () => {} },
  onStop() {},
  onRequest: async request => { dispatched++; return { status: 200, body: { ok: true, path: request.path, privateValue: 'encrypted-round-trip' } }; },
});
let browser;
try {
  await remote.ready;
  const connected = await remote.set({ enabled: true });
  assert.equal(connected.connected, true, connected.lastError);
  browser = createBrowser({ driverId: connected.deviceId });
  const result = await browser.request('GET', '/api/capabilities');
  assert.equal(result.privateValue, 'encrypted-round-trip');
  assert.equal(result.connection.stage, 'ws_auth');
  assert.equal(dispatched, 1);
  await browser.close();
  assert.equal(dispatched, 1, 'session close must not execute browser work');
  const closed = Promise.all(sockets.map(socket => new Promise(resolve => socket.once('close', resolve))));
  await remote.set({ enabled: false });
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker did not acknowledge WebSocket close')), 3000); })]);
  } finally { clearTimeout(timer); }
  console.log(`Encrypted Worker round trip and clean close passed: ${origin}`);
} finally { await browser?.close(); await remote.set({ enabled: false }); remote.dispose(); for (const socket of sockets) socket.terminate(); }
