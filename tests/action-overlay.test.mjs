import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissActionOverlay, rippleActionOverlay, showActionOverlay } from '../extension/action-overlay.js';

test('overlay specs carry a preview pointer separate from the page expression', () => {
  const shown = showActionOverlay(10, 20, { x: 1, y: 2, width: 3, height: 4 }, '点击');
  assert.equal(typeof shown.expression, 'string');
  assert.match(shown.expression, /data-bro-relay-action-overlay/);
  assert.deepEqual(shown.pointer, { x: 10, y: 20, label: '点击', rect: { x: 1, y: 2, width: 3, height: 4 }, kind: 'move' });
  assert.equal(rippleActionOverlay(3, 4).pointer.kind, 'click');
  assert.equal(rippleActionOverlay(3, 4).pointer.x, 3);
  assert.equal(dismissActionOverlay().pointer, null);
  assert.equal(typeof dismissActionOverlay().expression, 'string');
});
