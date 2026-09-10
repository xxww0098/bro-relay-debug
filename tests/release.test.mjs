import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../extension/automation.js';

test('POST /api/release dismisses the pointer without opening a preview', async () => {
  const pointers = [];
  const previewed = [];
  const ended = [];
  const executor = createAutomation({
    resolveTab: async () => 11,
    beginTask: async (tabId) => { previewed.push(tabId); return { id: 'lease' }; },
    endTask: async () => {},
    endPreview: async (tabId) => { ended.push(tabId); },
    onPointer: (tabId, pointer) => pointers.push([tabId, pointer]),
    send: async () => ({ result: { value: { ok: true, dismissed: true } } }),
  });
  const result = await executor.request('POST', '/api/release', { tabId: 't_example123' }, 'remote');
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.deepEqual(previewed, []);
  assert.deepEqual(ended, [11]);
  assert.deepEqual(pointers.at(-1), [11, null]);
});
