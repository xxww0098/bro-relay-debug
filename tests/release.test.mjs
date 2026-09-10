import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../extension/automation.js';
import { ACTION_OVERLAY_SELECTOR } from '../extension/action-overlay.js';

test('POST /api/release force-dismisses the on-page pointer overlay', async () => {
  const sent = [];
  const executor = createAutomation({
    resolveTab: async () => 11,
    send: async (tabId, method, params) => {
      sent.push([tabId, method, params]);
      return { result: { value: { ok: true, dismissed: true } } };
    },
  });
  const result = await executor.request('POST', '/api/release', { tabId: 't_example123' }, 'remote');
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  const dismiss = sent.find(([, , params]) =>
    String(params?.expression).includes(ACTION_OVERLAY_SELECTOR) &&
    String(params.expression).includes('dismiss'));
  assert.ok(dismiss, 'release must dismiss the overlay on the page');
});