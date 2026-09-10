// Shared Web Crypto protocol. Importable unchanged by browsers and Node.
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const bytes = value => { const json = JSON.stringify(value); check(typeof json === 'string'); return enc.encode(json); };
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export const LIMITS = Object.freeze({ sessions: 16, handshakeMs: 30_000, sessionMs: 600_000, window: 128, inflight: 8, messages: 1_000_000, requestBytes: 131_072, responseBytes: 16_777_216 });
function fail(code) { throw Object.assign(new Error(code === 'invalid_pairing' ? 'Invalid or legacy driver ID; pair again' : code), { code }); }
function check(ok, code = 'invalid_message') { if (!ok) fail(code); }
function encode(value) {
  const array = new Uint8Array(value), chunks = [];
  for (let i = 0; i < array.length; i += 32768) chunks.push(String.fromCharCode(...array.subarray(i, i + 32768)));
  return btoa(chunks.join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value, length) {
  check(typeof value === 'string' && (length === undefined || value.length === Math.ceil(length * 4 / 3)) && /^[A-Za-z0-9_-]+$/.test(value));
  const out = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  check(encode(out) === value && (length === undefined || out.length === length));
  return out;
}
function shape(value, keys) { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')); }
function origin(value) {
  const url = new URL(value);
  check(url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'invalid_pairing');
  return value;
}
export async function createPairing(relayOrigin) {
  const pairing = { origin: origin(relayOrigin), secret: random() };
  return `br2.${encode(bytes([pairing.origin, await routeFor(pairing), pairing.secret]))}`;
}
export function parsePairing(value) {
  try {
    check(typeof value === 'string' && value.length < 2048 && value.startsWith('br2.'), 'invalid_pairing');
    const fields = JSON.parse(dec.decode(decode(value.slice(4))));
    check(Array.isArray(fields) && fields.length === 3);
    const [relayOrigin, route, secret] = fields;
    origin(relayOrigin); check(typeof route === 'string' && /^[A-Za-z0-9_-]{16}$/.test(route)); decode(secret, 32);
    return Object.freeze({ origin: relayOrigin, route, secret });
  } catch { fail('invalid_pairing'); }
}
async function derive(pairing, label, context) {
  const key = await crypto.subtle.importKey('raw', decode(pairing.secret, 32), 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(['bro-relay', 2, pairing.origin]), info: bytes([label, context]) }, key, 256);
}
export async function deriveHubToken(pairing) { return encode(await derive(pairing, 'hub-auth', null)); }
async function routeFor(pairing) { return encode(await crypto.subtle.digest('SHA-256', enc.encode(await deriveHubToken(pairing)))).slice(0, 16); }
async function validatePairing(pairing) { origin(pairing.origin); check(pairing.route === await routeFor(pairing), 'invalid_pairing'); }
const transcript = (pairing, hello, epoch, nonce) => ['bro-relay', 2, pairing.origin, pairing.route, hello.client, epoch, nonce];
async function authKey(pairing, t) { return crypto.subtle.importKey('raw', await derive(pairing, 'endpoint-auth', t), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function proof(key, role, t) { return encode(await crypto.subtle.sign('HMAC', key, bytes([role, t]))); }
async function verify(key, role, t, value) { check(await crypto.subtle.verify('HMAC', key, decode(value, 32), bytes([role, t])), 'authentication_failed'); }
async function session(pairing, t, role, expires, alive = () => true, onClose = () => {}) {
  const sid = encode(await crypto.subtle.digest('SHA-256', bytes(t)));
  const directions = ['client', 'device'];
  const keys = await Promise.all(directions.map(async direction => crypto.subtle.importKey('raw', await derive(pairing, `aead-${direction}`, t), 'AES-GCM', false, ['encrypt', 'decrypt'])));
  const send = directions.indexOf(role), receive = 1 - send;
  const sizes = [LIMITS.requestBytes, LIMITS.responseBytes];
  let sequence = 0, highest = -1, closed = false;
  const seen = new Set(), pending = new Set();
  function active() { check(!closed && alive() && Date.now() < expires, 'session_expired'); }
  function header(e) { return bytes(['bro-relay', 2, e.session, e.direction, e.requestId, e.sequence]); }
  function nonce(n) { const out = new Uint8Array(12); new DataView(out.buffer).setUint32(8, n); return out; }
  function fresh(n) { check(!seen.has(n) && n > highest - LIMITS.window, 'replay'); }
  return {
    id: sid,
    expires,
    close() { closed = true; onClose(sid); },
    async seal(requestId, payload) {
      active(); check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId));
      const plaintext = bytes(payload); check(plaintext.length <= sizes[send], 'quota_exceeded');
      check(sequence < LIMITS.messages, 'session_expired');
      // Reserve before await: concurrent senders must never reuse a nonce.
      const envelope = { session: sid, direction: role, requestId, sequence: sequence++ };
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(envelope.sequence), additionalData: header(envelope), tagLength: 128 }, keys[send], plaintext);
      active(); return { ...envelope, ciphertext: encode(ciphertext) };
    },
    async open(input) {
      active(); shape(input, 'session,direction,requestId,sequence,ciphertext');
      const e = { ...input }; // Do not permit caller mutation during crypto awaits.
      check(e.session === sid && e.direction === directions[receive], 'authentication_failed');
      check(typeof e.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(e.requestId));
      check(Number.isSafeInteger(e.sequence) && e.sequence >= 0 && e.sequence < LIMITS.messages);
      check(typeof e.ciphertext === 'string' && e.ciphertext.length <= Math.ceil((sizes[receive] + 16) * 4 / 3), 'quota_exceeded');
      fresh(e.sequence); check(!pending.has(e.sequence), 'replay');
      check(pending.size < LIMITS.inflight, 'quota_exceeded');
      pending.add(e.sequence);
      try {
        let plaintext;
        try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(e.sequence), additionalData: header(e), tagLength: 128 }, keys[receive], decode(e.ciphertext)); }
        catch { fail('authentication_failed'); }
        active(); fresh(e.sequence);
        highest = Math.max(highest, e.sequence); seen.add(e.sequence);
        for (const n of seen) if (n <= highest - LIMITS.window) seen.delete(n);
        try { return { requestId: e.requestId, payload: JSON.parse(dec.decode(plaintext)) }; }
        catch { fail('invalid_message'); }
      } finally { pending.delete(e.sequence); }
    },
  };
}
export async function createClient(pairing) {
  await validatePairing(pairing);
  const hello = Object.freeze({ v: 2, route: pairing.route, origin: pairing.origin, client: random() });
  const deadline = Date.now() + LIMITS.handshakeMs;
  let used = false;
  return { hello, async finish(input) {
    check(!used && Date.now() < deadline, 'session_expired'); used = true;
    shape(input, 'v,epoch,nonce,proof'); const challenge = { ...input };
    check(challenge.v === 2); decode(challenge.epoch, 32); decode(challenge.nonce, 32);
    const t = transcript(pairing, hello, challenge.epoch, challenge.nonce);
    const key = await authKey(pairing, t);
    await verify(key, 'device', t, challenge.proof);
    const finish = { v: 2, nonce: challenge.nonce, proof: await proof(key, 'client', t) };
    return { finish, session: await session(pairing, t, 'client', Date.now() + LIMITS.sessionMs) };
  } };
}
export async function createDevice(pairing) {
  await validatePairing(pairing);
  const epoch = random(), pending = new Map(), sessions = new Map();
  let closed = false;
  function clean() {
    check(!closed, 'session_expired');
    for (const [id, p] of pending) if (Date.now() >= p.expires) pending.delete(id);
    for (const [id, s] of sessions) if (Date.now() >= s.expires) { s.close(); sessions.delete(id); }
  }
  return {
    close() { closed = true; pending.clear(); for (const s of sessions.values()) s.close(); sessions.clear(); },
    getSession(id) { clean(); const result = sessions.get(id); check(result, 'session_expired'); return result; },
    async accept(input) {
      clean(); shape(input, 'v,route,origin,client'); const hello = { ...input };
      check(hello.v === 2 && hello.route === pairing.route && hello.origin === pairing.origin, 'authentication_failed'); decode(hello.client, 32);
      check(sessions.size + pending.size < LIMITS.sessions, 'quota_exceeded');
      const nonce = random(), t = transcript(pairing, hello, epoch, nonce);
      const p = { t, expires: Date.now() + LIMITS.handshakeMs };
      pending.set(nonce, p);
      try {
        const key = await authKey(pairing, t); p.key = key;
        const result = { v: 2, epoch, nonce, proof: await proof(key, 'device', t) };
        clean(); check(pending.get(nonce) === p, 'session_expired'); return result;
      } catch (error) { pending.delete(nonce); throw error; }
    },
    async finish(input) {
      clean(); shape(input, 'v,nonce,proof'); const finish = { ...input };
      check(finish.v === 2); decode(finish.nonce, 32);
      const p = pending.get(finish.nonce); check(p?.key && !p.finishing, 'session_expired'); p.finishing = true;
      try {
        await verify(p.key, 'client', p.t, finish.proof);
        const result = await session(pairing, p.t, 'device', Date.now() + LIMITS.sessionMs, () => !closed, id => sessions.delete(id));
        clean(); check(pending.get(finish.nonce) === p, 'session_expired');
        sessions.set(result.id, result); return result;
      } finally { pending.delete(finish.nonce); }
    },
  };
}
