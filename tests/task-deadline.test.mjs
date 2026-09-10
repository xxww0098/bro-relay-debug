import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskQueue } from '../extension/tasks.js';

test('queued work expires before it can execute after a delayed predecessor', async () => {
  const queue = createTaskQueue();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = queue.start(1, () => held, 1000);
  let executed = false;
  const second = queue.start(1, () => { executed = true; }, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await first.done;
  const result = await second.done;
  assert.equal(executed, false);
  assert.equal(result.error.code, 'task_timeout');
});
