import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowser, routeIdFor, parseDriverId } from '../cli/sdk.js';
import { filterNodes } from '../cli/index.js';

function mockHub(handler) {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const out = await handler(req, text ? JSON.parse(text) : null);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body ?? out));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('remote SDK sends route, bearer credential, and stable task ID', async () => {
  const seen = []; const hub = await mockHub((req, body) => { seen.push({ req, body }); return { ok: true, tabs: [{ id: 'tab_1' }] }; });
  try {
    const browser = createBrowser({ driverId: 'a'.repeat(24) }, { hubUrl: hub.url });
    const result = await browser.request('POST', '/api/actions', { tabId: 'tab_1', actions: [] });
    assert.equal(result.ok, true); assert.equal(seen[0].req.url, '/v1/rpc');
    assert.equal(seen[0].req.headers.authorization, `Bearer ${'a'.repeat(24)}`);
    assert.match(seen[0].body.body.taskId, /^job_[\w-]{36}$/);
    assert.equal(seen[0].body.routeId, routeIdFor('a'.repeat(24)));
  } finally { hub.server.close(); }
});

test('SDK preserves screenshot response and reports structured remote errors', async () => {
  const hub = await mockHub((req) => req.url === '/v1/rpc' ? { status: 200, body: { ok: true, data: 'aGVsbG8=' } } : {});
  try { const b = createBrowser({ driverId: 'b'.repeat(24) }, { hubUrl: hub.url }); assert.deepEqual(await b.request('GET', '/api/screenshot'), { ok: true, data: 'aGVsbG8=' }); }
  finally { hub.server.close(); }
  const bad = await mockHub(() => ({ status: 409, body: { ok: false, code: 'remote_device_offline', message: 'offline' } }));
  try { await assert.rejects(() => createBrowser({ driverId: 'c'.repeat(24) }, { hubUrl: bad.url }).request('GET', '/api/tabs'), e => e.code === 'remote_device_offline' && e.status === 409); }
  finally { bad.server.close(); }
});

test('partial action failures keep task identity and pre-cancelled calls never dispatch', async () => {
  const frames = [];
  const browser = createBrowser(parseDriverId('br-' + 'z'.repeat(43)), {
    fetch: async (_url, request) => {
      const frame = JSON.parse(request.body); frames.push(frame);
      return new Response(JSON.stringify({ ok: false, code: 'element_not_found', message: 'Second action failed',
        task: { id: frame.body.taskId, completedActions: 1, status: 'failed' } }), { status: 400 });
    },
  });
  await assert.rejects(browser.request('POST', '/api/actions', { actions: [{ type: 'click' }] }), error => {
    assert.equal(error.taskId, frames[0].body.taskId);
    assert.equal(error.payload.task.completedActions, 1);
    return true;
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browser.request('POST', '/api/actions', {}, { signal: controller.signal }), { code: 'request_cancelled' });
  assert.equal(frames.length, 1);
});

test('lost responses retain the original task ID and send cancellation without replay', async () => {
  const frames = [];
  const browser = createBrowser(parseDriverId('br-' + 'x'.repeat(43)), {
    fetch: async (_url, request) => {
      const frame = JSON.parse(request.body); frames.push(frame);
      if (frame.path === '/api/actions') throw new Error('socket lost');
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  await assert.rejects(browser.request('POST', '/api/actions', { actions: [] }), error => {
    assert.equal(error.code, 'unknown_outcome');
    assert.equal(error.taskId, frames[0].body.taskId);
    assert.equal(error.payload.retryable, false);
    return true;
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[1].path, `/api/tasks/${frames[0].body.taskId}/cancel`);
});

test('find filters accessible names before truncating and returns actionable refs', () => {
  const nodes = [{ ref: 'other', role: 'button', name: 'Unrelated' },
    ...Array.from({ length: 101 }, (_, i) => ({ ref: `e1_${i}`, role: 'button', name: 'Save item' }))];
  const result = filterNodes(nodes, 'SAVE');
  assert.equal(result.total, 101);
  assert.equal(result.matches.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0].ref, 'e1_0');
  assert.deepEqual(filterNodes(nodes, 'missing').matches, []);
});
