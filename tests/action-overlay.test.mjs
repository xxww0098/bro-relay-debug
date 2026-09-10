import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissActionOverlay, rippleActionOverlay, showActionOverlay } from '../extension/action-overlay.js';

test('overlay specs embed a page-local expression', () => {
  const shown = showActionOverlay(10, 20, { x: 1, y: 2, width: 3, height: 4 }, '点击');
  assert.equal(typeof shown.expression, 'string');
  assert.match(shown.expression, /data-bro-relay-action-overlay/);
  assert.match(shown.expression, /"点击"/);
  assert.equal(typeof rippleActionOverlay(3, 4).expression, 'string');
  assert.match(rippleActionOverlay(3, 4).expression, /"ripple"/);
  assert.equal(typeof dismissActionOverlay().expression, 'string');
  assert.match(dismissActionOverlay().expression, /"dismiss"/);
});