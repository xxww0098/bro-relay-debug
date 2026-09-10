import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../extension/automation.js';

test('revocation fences requests still resolving a tab before close or task creation', async () => {
  for (const [path, body] of [
    ['/api/tabs/close', {}],
    ['/api/evaluate', { expression: 'document.title' }],
    ['/api/actions', { actions: [{ type: 'click', target: '#submit' }] }],
  ]) {
    let finishResolve, mutations = 0;
    const executor = createAutomation({
      resolveTab: () => new Promise(resolve => { finishResolve = resolve; }),
      closeTab: () => { mutations++; }, send: () => { mutations++; },
    });
    const connection = new AbortController();
    const pending = executor.request('POST', path, { tabId: 't_example123', ...body }, 'remote', connection.signal);
    // The new connection may already be enabled; this old connection's signal stays revoked.
    connection.abort();
    executor.cancelAll(); executor.disconnect('remote');
    finishResolve(1);
    await assert.rejects(pending, { code: 'task_cancelled' });
    assert.equal(mutations, 0);
    assert.equal(executor.activeTasks().length, 0);
  }
});
