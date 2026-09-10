import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHub } from '../scripts/build.mjs';

test('build only embeds a public HTTPS origin, allowing local test hubs', () => {
  assert.equal(validateHub('https://relay.example.com/'), 'https://relay.example.com');
  assert.equal(validateHub('http://127.0.0.1:18796'), 'http://127.0.0.1:18796');
  for (const url of ['http://remote.example.com', 'https://u:p@relay.example.com', 'https://relay.example.com/path', 'https://relay.example.com/?token=secret', 'file:///tmp/hub']) {
    assert.throws(() => validateHub(url));
  }
});
