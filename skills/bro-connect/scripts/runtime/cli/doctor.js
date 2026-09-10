import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { validateHub } from '../extension/hub-url.js';

export async function diagnose(value, { lookup: lookupImpl = lookup, fetch: fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const origin = validateHub(value), url = new URL(origin), checks = [];
  let failed = false;
  async function check(stage, run) {
    const started = Date.now();
    const item = { side: 'operator', origin, stage, outcome: failed ? 'skipped' : 'passed', observedAt: new Date().toISOString(), durationMs: 0 };
    if (!failed) {
      let timer;
      try {
        await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject({ code: 'probe_timeout' }), timeoutMs); })]);
      } catch (error) { item.outcome = 'failed'; item.code = error.code || 'probe_failed'; failed = true; }
      finally { clearTimeout(timer); item.durationMs = Date.now() - started; }
    }
    checks.push(item);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  await check('dns', () => lookupImpl(hostname));
  if (url.protocol === 'https:') await check('tls', () => new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(url.port) || 443, ...(isIP(hostname) ? {} : { servername: hostname }), timeout: timeoutMs });
    socket.once('secureConnect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject({ code: 'tls_timeout' }); });
  }));
  else checks.push({ side: 'operator', origin, stage: 'tls', outcome: 'skipped', code: 'local_http', durationMs: 0, observedAt: new Date().toISOString() });
  await check('https_health', async () => {
    const response = await fetchImpl(`${origin}/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body?.getReader();
    let size = 0, text = '';
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 4096) throw { code: 'invalid_health' };
        text += new TextDecoder().decode(value, { stream: true });
      }
    } finally { await reader?.cancel().catch(() => {}); }
    const body = JSON.parse(text);
    if (!response.ok || body.ok !== true || body.service !== 'browser-relay-hub') throw { code: 'invalid_health' };
  });
  for (const stage of ['ws_auth', 'rpc']) checks.push({ side: 'remote', origin, stage, outcome: 'unknown', durationMs: 0, observedAt: new Date().toISOString() });
  return { ok: !failed, connected: false, checks };
}
