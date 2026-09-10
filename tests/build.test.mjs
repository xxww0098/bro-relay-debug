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

import { cp, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('build.sh loads env from its directory and emits a versioned configured ZIP', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bro-build-')));
  try {
    for (const file of ['build.sh', 'scripts', 'cli', 'extension', 'skills', 'package.json', '.env.example', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await cp(new URL(`../${file}`, import.meta.url), join(root, file), { recursive: true });
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    pkg.version = '9.8.7';
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, '.env'), 'BRO_RELAY_HUB_URL=https://env.example.com\n');
    const env = { ...process.env };
    delete env.BRO_RELAY_HUB_URL;
    for (const hub of ['https://env.example.com', 'https://override.example.com']) {
      if (hub.includes('override')) env.BRO_RELAY_HUB_URL = hub;
      const result = JSON.parse(execFileSync('bash', [join(root, 'build.sh')], { cwd: tmpdir(), env, encoding: 'utf8' }));
      assert.equal(result.hub, hub);
      assert.equal(result.archive, join(root, 'dist/bro-relay-debug-extension-9.8.7.zip'));
      const manifest = JSON.parse(execFileSync('unzip', ['-p', result.archive, 'manifest.json']));
      assert.equal(manifest.version, '9.8.7');
      assert.deepEqual(manifest.host_permissions, [`${hub}/*`]);
      assert.ok(execFileSync('unzip', ['-p', result.archive, 'config.js'], { encoding: 'utf8' }).includes(hub));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
