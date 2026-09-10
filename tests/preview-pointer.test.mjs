import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedImageBox, mapPointerToFrame } from '../extension/preview-pointer.js';

test('pointer CSS coordinates map onto the letterboxed screenshot', () => {
  const frame = { x: 10, y: 20, width: 400, height: 300 };
  const mapped = mapPointerToFrame(
    { x: 100, y: 50, label: '点击', kind: 'click', rect: { x: 80, y: 40, width: 40, height: 20 } },
    { width: 200, height: 100 },
    frame,
  );
  assert.equal(mapped.x, 210);
  assert.equal(mapped.y, 170);
  assert.equal(mapped.scale, 2);
  assert.deepEqual(mapped.rect, { x: 170, y: 150, width: 80, height: 40 });
});

test('contained image box letterboxes a wide screenshot inside the frame', () => {
  const box = displayedImageBox({
    naturalWidth: 200, naturalHeight: 100,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 400 }),
  });
  assert.deepEqual(box, { x: 0, y: 100, width: 400, height: 200 });
});
