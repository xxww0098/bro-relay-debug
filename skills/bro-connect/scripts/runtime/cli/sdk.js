import { createHash, randomUUID } from 'node:crypto';
import { HUB_URL } from '../config.js';
import { isTaskRequest } from '../extension/protocol.js';

export function routeIdFor(secret) {
  return createHash('sha256').update(secret).digest('base64url').slice(0, 16);
}

export function parseDriverId(value) {
  const match = /^br-([A-Za-z0-9_-]{16,128})$/.exec(String(value || '').trim());
  if (!match) throw new RelayError({ code: 'invalid_driver_id', message: 'Expected a br-<secret> driver ID', status: 400 });
  return { driverId: match[1], routeId: routeIdFor(match[1]) };
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

function endpoint(options) {
  // The build owns the public endpoint; dependency injection is for tests/SDK callers.
  const url = new URL(options.hubUrl ?? HUB_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Hub requires HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Hub must be a plain origin');
  return url.origin;
}

function credentials(connection) {
  if (!connection || !/^[A-Za-z0-9_-]{16,128}$/.test(connection.driverId || '')) {
    throw new RelayError({ code: 'invalid_driver_id', message: 'Invalid saved connection; reconnect with the current driver ID' });
  }
  return { secret: connection.driverId, routeId: routeIdFor(connection.driverId) };
}

async function responseJson(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new RelayError({ code: 'invalid_response', message: 'Hub returned an invalid response', status: response.status }); }
  if (!response.ok || data?.ok === false) {
    throw new RelayError({ ...data, status: data?.status || response.status });
  }
  return data;
}

export function createBrowser(connection, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const hub = endpoint(options);
  const { secret, routeId } = credentials(connection);
  async function request(method, path, body, { signal, timeoutMs = 35000 } = {}) {
    if (signal?.aborted) throw new RelayError({ code: 'request_cancelled', message: 'Request cancelled before dispatch', status: 409, retryable: false });
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
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`${hub}/v1/rpc`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: randomUUID(), routeId, method, path, body: body ?? null }),
        signal: controller.signal,
      });
      return await responseJson(response);
    } catch (error) {
      const uncertain = !(error instanceof RelayError) ||
        ['invalid_response', 'remote_request_timeout', 'rpc_timeout', 'remote_device_offline', 'remote_send_failed'].includes(error.code);
      if (!uncertain || (method === 'GET' && !tracked && error instanceof RelayError)) {
        if (taskId) { error.taskId ||= taskId; error.payload.taskId ||= taskId; }
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
  return {
    request,
    capabilities: () => request('GET', '/api/capabilities'),
    tabs: () => request('GET', '/api/tabs'),
  };
}

export async function status(connection, options = {}) {
  const { secret, routeId } = credentials(connection);
  const response = await (options.fetch ?? globalThis.fetch)(`${endpoint(options)}/v1/status/${routeId}`, {
    redirect: 'error', headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  return responseJson(response);
}

export function request(connection, method, path, body, options = {}) {
  return createBrowser(connection, options).request(method, path, body, options);
}
