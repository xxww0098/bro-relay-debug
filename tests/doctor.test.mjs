import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnose } from '../cli/doctor.js';

test('doctor reports local health separately from unmeasured remote connectivity', async t => {
  const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, service: 'browser-relay-hub' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const report = await diagnose(`http://127.0.0.1:${server.address().port}`);
  assert.equal(report.connected, false);
  assert.equal(report.checks.find(c => c.stage === 'https_health').outcome, 'passed');
  assert.equal(report.checks.find(c => c.stage === 'rpc').outcome, 'unknown');
  const failed = await diagnose('https://relay.invalid', { lookup: async () => { throw Object.assign(new Error('private detail'), {code:'ENOTFOUND'}); } });
  assert.equal(failed.checks[0].outcome, 'failed');
  assert.equal(failed.checks[1].outcome, 'skipped');
  assert.equal(JSON.stringify(failed).includes('private detail'), false);
});
