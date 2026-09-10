import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSkill } from '../scripts/build.mjs';

test('copied skill runs without the source checkout or npm installation', async () => {
  await buildSkill();
  const temporary = await mkdtemp(join(tmpdir(), 'bro-skill-'));
  try {
    await cp(new URL('../skills/bro-connect/', import.meta.url), temporary, { recursive: true });
    const result = JSON.parse(execFileSync(process.execPath, [join(temporary, 'scripts/bro.mjs'), '--help'], { cwd: temporary, encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.match(result.usage, /connect --stdin/);
    assert.match(result.usage, /release/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
