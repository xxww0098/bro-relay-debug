import { randomUUID } from 'node:crypto';
import { validateHub } from '../extension/hub-url.js';
import { isTaskRequest } from '../extension/protocol.js';
import { parsePairing, deriveHubToken, createClient } from '../extension/relay-crypto.js';

export function parseDriverId(value) {
  const driverId = String(value || '').trim();
  try { return { driverId, hubUrl: parsePairing(driverId).origin }; }
  catch { throw new RelayError({ code: 'invalid_driver_id', message: 'Invalid or legacy driver ID; pair again', status: 400 }); }
}

export class RelayError extends Error {
  constructor(payload) {
    super(payload.message || payload.error || 'Remote request failed');
    this.payload = { ...payload, ok: false };
    this.code = payload.code || 'remote_error';
    this.status = payload.status || 500;
    this.taskId = payload.taskId || payload.task?.id;
    if (this.taskId) this.payload.taskId = this.taskId;
  }
}

function credentials(connection, options) {
  const parsed = parseDriverId(connection?.driverId);
  const pairing = parsePairing(parsed.driverId);
  for (const hub of [connection?.hubUrl, options.hubUrl]) {
    if (hub !== undefined && validateHub(hub) !== pairing.origin) {
      throw new RelayError({ code: 'hub_mismatch', message: 'Hub differs from the paired origin; pair again to change it', status: 400 });
    }
  }
  return pairing;
}

async function responseJson(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new RelayError({ code: 'invalid_response', message: 'Hub returned an invalid response', status: response.status }); }
  if (!response.ok || data?.ok !== true) {
    // Hub errors describe transport only and cannot authenticate browser outcomes.
    throw new RelayError({ code: 'transport_error', message: 'Hub transport request failed', status: response.status,
      transportCode: typeof data?.code === 'string' && /^[a-z_]{1,64}$/.test(data.code) ? data.code : undefined });
  }
  return data;
}

export function createBrowser(connection, options = {}) {
  const pairing = credentials(connection, options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let token, session, opening, closed = false;
  async function exchange(id, payload, signal, timeoutMs) {
    token ??= await deriveHubToken(pairing);
    const response = await fetchImpl(`${pairing.origin}/v1/rpc`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, routeId: pairing.route, timeoutMs, payload }), signal,
    });
    return (await responseJson(response)).payload;
  }
  async function openResult(current, id, result) {
    if (result?.type !== 'rpc.result') throw new RelayError({ code: 'invalid_response', message: 'Expected an encrypted browser response' });
    const opened = await current.open(result.envelope);
    if (opened.requestId !== id) throw new RelayError({ code: 'authentication_failed', message: 'Response request ID does not match' });
    const value = opened.payload;
    if (!Number.isInteger(value?.status) || value.status < 100 || value.status > 599 || !value.body || typeof value.body !== 'object') {
      throw new RelayError({ code: 'invalid_response', message: 'Invalid encrypted browser response' });
    }
    return value;
  }
  async function connect(signal, timeoutMs) {
    if (closed) throw new RelayError({ code: 'session_closed', message: 'Browser session is closed' });
    opening ??= (async () => {
      const client = await createClient(pairing);
      const challenge = await exchange(randomUUID(), { type: 'session.hello', hello: client.hello }, signal, timeoutMs);
      if (challenge?.type !== 'session.challenge') throw new RelayError({ code: 'authentication_failed', message: 'Expected an authenticated device challenge' });
      const established = await client.finish(challenge.challenge);
      // Keep the session for close even if the finish acknowledgement is lost.
      session = established.session;
      const id = randomUUID();
      const result = await openResult(session, id, await exchange(id, { type: 'session.finish', finish: established.finish }, signal, timeoutMs));
      if (result.status !== 200 || result.body.ok !== true) throw new RelayError({ code: 'authentication_failed', message: 'Device refused the session' });
      return session;
    })();
    try { return await opening; }
    catch (error) { closed = true; throw error; }
  }
  async function request(method, path, body, { signal, timeoutMs = 35000 } = {}) {
    if (signal?.aborted) throw new RelayError({ code: 'request_cancelled', message: 'Request cancelled before dispatch', status: 409, retryable: false });
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Expected a positive timeoutMs');
    const query = new URL(path, 'http://relay.local');
    if (!path.startsWith('/api/') || !['GET', 'POST'].includes(method)) throw new Error('Expected GET or POST and an /api/ path');
    const tracked = isTaskRequest(method, query.pathname);
    const taskId = tracked ? (method === 'GET' ? query.searchParams.get('taskId') : body?.taskId) || `job_${randomUUID()}` : undefined;
    const sessionId = method === 'GET' ? query.searchParams.get('sessionId') : body?.sessionId;
    if (tracked) {
      if (method === 'GET') { query.searchParams.set('taskId', taskId); path = query.pathname + query.search; }
      else body = { ...body, taskId };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let dispatched = false, authenticated = false;
    try {
      const current = await connect(controller.signal, Math.min(timeoutMs, 30000));
      if (controller.signal.aborted) throw new RelayError({ code: 'request_cancelled', message: 'Request cancelled before dispatch', status: 409 });
      const id = randomUUID();
      const envelope = await current.seal(id, { kind: 'rpc', method, path, body: body ?? null, deadline: Date.now() + Math.min(timeoutMs, 30000) });
      if (controller.signal.aborted) throw new RelayError({ code: 'request_cancelled', message: 'Request cancelled before dispatch', status: 409 });
      dispatched = true;
      const result = await openResult(current, id, await exchange(id, { type: 'rpc', envelope }, controller.signal, Math.min(timeoutMs, 30000)));
      authenticated = true;
      if (result.status >= 400 || result.body.ok === false) throw new RelayError({ ...result.body, status: result.status });
      return result.body;
    } catch (error) {
      if (!dispatched || authenticated || (method === 'GET' && !tracked)) {
        if (authenticated && taskId) { error.taskId ||= taskId; error.payload.taskId ||= taskId; }
        throw error;
      }
      let cancellationRequested = false;
      if (taskId) {
        try {
          await request('POST', `/api/tasks/${encodeURIComponent(taskId)}/cancel`, { sessionId }, { timeoutMs: 2500 });
          cancellationRequested = true;
        } catch { /* Remote outcome stays unknown; never replay the command. */ }
      }
      throw new RelayError({
        code: 'unknown_outcome', status: 504, retryable: false,
        message: 'Connection lost or timed out; inspect the task/page before retrying. Completed actions are not undone.',
        ...(taskId ? { taskId, sessionId, cancellationRequested } : {}),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function close() {
    closed = true;
    try { await opening; } catch { /* Close a possibly established session below. */ }
    if (!session) return;
    const current = session; session = undefined;
    try {
      const id = randomUUID();
      const envelope = await current.seal(id, { kind: 'close' });
      await openResult(current, id, await exchange(id, { type: 'rpc', envelope }, AbortSignal.timeout(2500), 2500));
    } catch { /* Best effort cleanup; never mask the command result. */ }
    finally { current.close(); }
  }
  return { request, close, capabilities: () => request('GET', '/api/capabilities'), tabs: () => request('GET', '/api/tabs') };
}

export async function status(connection, options = {}) {
  const pairing = credentials(connection, options);
  const token = await deriveHubToken(pairing);
  const response = await (options.fetch ?? globalThis.fetch)(`${pairing.origin}/v1/status/${pairing.route}`, {
    redirect: 'error', headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  const data = await responseJson(response);
  return { ok: true, transportOnly: true, connected: data.connected === true, lastSeen: data.lastSeen ?? null };
}

export async function handshake(connection, options = {}) {
  const browser = createBrowser(connection, options);
  try {
    const capabilities = await browser.capabilities();
    if (capabilities.protocolVersion !== 2) throw new RelayError({ code: 'incompatible_extension', message: 'Install the matching Bro Relay Debug extension', status: 409 });
    return { connected: true, protocolVersion: 2, features: capabilities.features || [],
      ...(capabilities.connection ? { remoteDiagnostic: capabilities.connection } : {}) };
  } finally { await browser.close(); }
}

export async function request(connection, method, path, body, options = {}) {
  const browser = createBrowser(connection, options);
  try { return await browser.request(method, path, body, options); }
  finally { await browser.close(); }
}
