import { createPairing, parsePairing, deriveHubToken, createDevice, LIMITS } from './relay-crypto.js';
import { validateHub } from './hub-url.js';
// Owns the persisted switch/credential and exactly one authenticated socket.
export function createRemoteControl({ storage, hubUrl, onRequest, onStop, onStatus = () => {}, hasPermission = async () => true, socketFactory = url => new WebSocket(url) }) {
  let config = {}, generation = 0, socket, authenticated = false, connecting, connectionAbort, encryptedDevice;
  let reconnectTimer, heartbeatTimer, rejectConnect, mutations = Promise.resolve(), stopping = Promise.resolve();
  hubUrl = validateHub(hubUrl);
  let lastError = null, attempt = 0, diagnostic = null;
  function record(stage, outcome, started = Date.now(), code) {
    diagnostic = { side: 'remote', origin: config.remoteHubUrl || hubUrl, stage, outcome, durationMs: Date.now() - started, observedAt: new Date().toISOString(), ...(code ? { code } : {}) };
  }
  const status = () => ({ enabled: !!config.remoteControlEnabled, connected: authenticated,
    deviceId: config.remoteDeviceId || '', hubUrl: config.remoteHubUrl || hubUrl, diagnostic, lastError });
  const publish = () => onStatus(status());
  function close() {
    connectionAbort?.abort(); connectionAbort = undefined;
    encryptedDevice?.close(); encryptedDevice = undefined;
    clearTimeout(reconnectTimer); reconnectTimer = undefined;
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    const old = socket;
    socket = undefined;
    authenticated = false;
    if (old) { old.onmessage = old.onopen = old.onclose = old.onerror = null; old.close(); }
    rejectConnect?.(new Error('Connection superseded'));
    rejectConnect = undefined;
    connecting = undefined;
  }
  function sendHello() {
    if (!socket) throw new Error('not connected');
    socket.send(JSON.stringify({ type: 'device.hello' }));
  }
  function heartbeat() {
    if (!authenticated || !socket) return false;
    try { sendHello(); return true; }
    catch { return false; }
  }
  function schedule(revision) {
    if (revision !== generation || !config.remoteControlEnabled || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempt++, 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delay);
  }
  function connect() {
    if (connecting) return connecting;
    const revision = generation;
    const pending = connectOnce().catch(() => {
      if (revision === generation) { close(); lastError = 'Hub connection failed'; record('ws_auth', 'failed', Date.now(), 'transport_failed'); publish(); schedule(revision); }
      return status();
    }).finally(() => { if (connecting === pending) connecting = undefined; });
    connecting = pending;
    return pending;
  }
  async function connectOnce() {
    await stopping;
    if (!config.remoteControlEnabled) return status();
    if (authenticated) return status();
    const revision = generation;
    const origin = config.remoteHubUrl || hubUrl;
    if (!(await hasPermission(origin))) {
      if (revision === generation) { lastError = 'Hub permission required'; record('permission', 'failed', Date.now(), 'permission_required'); publish(); }
      return status();
    }
    if (revision !== generation || !config.remoteControlEnabled) return status();
    const pairing = parsePairing(config.remoteDeviceId);
    if (pairing.origin !== origin) throw new Error('Pair again for the selected Hub');
    const [token, device] = await Promise.all([deriveHubToken(pairing), createDevice(pairing)]);
    if (revision !== generation || !config.remoteControlEnabled) { device.close(); return status(); }
    encryptedDevice = device;
    const started = Date.now();
    record('ws_auth', 'pending', started);
    const wsUrl = new URL('/v1/device/connect', origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('routeId', pairing.route);
    const ws = socketFactory(wsUrl.href);
    const abort = new AbortController();
    connectionAbort = abort;
    socket = ws;
    const current = () => revision === generation && socket === ws && config.remoteControlEnabled;
    let inFlight = 0;
    const auth = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hub connection timed out')), 8000);
      rejectConnect = error => { clearTimeout(timer); reject(error); };
      ws.onopen = () => { if (current()) ws.send(JSON.stringify({ type: 'device.auth', secret: token })); };
      ws.onerror = () => { if (current()) { rejectConnect?.(new Error('Hub connection failed')); ws.close(); } };
      ws.onclose = () => {
        if (!current()) return;
        abort.abort();
        device.close();
        rejectConnect?.(new Error('Hub disconnected'));
        authenticated = false;
        socket = undefined;
        clearInterval(heartbeatTimer);
        lastError = 'Hub disconnected';
        record('ws_auth', 'failed', started, 'transport_failed');
        stopping = Promise.resolve(onStop());
        publish();
        schedule(revision);
      };
      ws.onmessage = event => {
        if (!current()) return;
        let message;
        if (typeof event.data !== 'string' || event.data.length > Math.ceil((LIMITS.requestBytes + 16) * 4 / 3) + 4096) { ws.close(1009, 'message too large'); return; }
        try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== 'object') return;
        if (!authenticated) {
          if (message.type !== 'device.authenticated') return;
          clearTimeout(timer);
          rejectConnect = undefined;
          authenticated = true;
          lastError = null;
          record('ws_auth', 'passed', started);
          attempt = 0;
          sendHello();
          // MV3 needs periodic traffic; merely keeping a WebSocket open is insufficient.
          heartbeatTimer = setInterval(() => { if (current() && authenticated) sendHello(); }, 20000);
          publish();
          resolve(status());
          return;
        }
        if (message.type === 'device.ping') {
          if (current() && authenticated) ws.send(JSON.stringify({ type: 'device.pong', id: message.id }));
          return;
        }
        if (message.type !== 'rpc.request' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id || '')) return;
        const reject = code => {
          if (current()) { try { ws.send(JSON.stringify({ type: 'rpc.response', id: message.id, error: { code } })); } catch { ws.close(); } }
        };
        if (inFlight >= 32) { reject('quota_exceeded'); return; }
        inFlight++;
        void (async () => {
          let sessionToClose;
          try {
            if (!current()) return;
            const payload = message.payload;
            let result;
            if (payload?.type === 'session.hello') {
              result = { type: 'session.challenge', challenge: await device.accept(payload.hello) };
            } else if (payload?.type === 'session.finish') {
              const session = await device.finish(payload.finish);
              result = { type: 'rpc.result', envelope: await session.seal(message.id, { status: 200, body: { ok: true } }) };
            } else if (payload?.type === 'rpc') {
              const session = device.getSession(payload.envelope?.session);
              const opened = await session.open(payload.envelope);
              if (opened.requestId !== message.id) throw { code: 'authentication_failed' };
              if (!current()) return;
              const request = opened.payload;
              let response;
              if (request?.kind === 'close') {
                sessionToClose = session;
                response = { status: 200, body: { ok: true } };
              } else {
                const remaining = request?.deadline - Date.now();
                if (request?.kind !== 'rpc' || !['GET', 'POST'].includes(request.method) ||
                    typeof request.path !== 'string' || !request.path.startsWith('/api/') ||
                    !Number.isSafeInteger(request.deadline) || remaining <= 0 || remaining > 30_000) {
                  response = { status: 400, body: { ok: false, code: 'invalid_request', message: 'Invalid or expired encrypted request' } };
                } else {
                  const requestAbort = new AbortController();
                  const cancel = () => requestAbort.abort();
                  abort.signal.addEventListener('abort', cancel, { once: true });
                  const deadline = setTimeout(cancel, remaining);
                  try {
                    if (abort.signal.aborted) requestAbort.abort();
                    response = await onRequest(request, requestAbort.signal);
                    if (request.path === '/api/capabilities') response.body.connection = diagnostic;
                  } catch (error) {
                    response = { status: error.status || 500, body: { ok: false, code: error.code || 'remote_exec_failed', message: error.message || 'Remote request failed' } };
                  } finally { clearTimeout(deadline); abort.signal.removeEventListener('abort', cancel); }
                }
              }
              try { result = { type: 'rpc.result', envelope: await session.seal(message.id, response) }; }
              catch (error) {
                if (error.code !== 'quota_exceeded') throw error;
                result = { type: 'rpc.result', envelope: await session.seal(message.id, { status: 413, body: { ok: false, code: 'response_body_too_large', message: 'Remote response exceeds size limit; reduce screenshot dimensions' } }) };
              }
            } else throw { code: 'invalid_message' };
            if (current()) ws.send(JSON.stringify({ type: 'rpc.response', id: message.id, payload: result }));
          } catch (error) {
            reject(['authentication_failed', 'session_expired', 'quota_exceeded'].includes(error.code) ? error.code : 'invalid_message');
          } finally { sessionToClose?.close(); inFlight--; }
        })();
      };
    });
    return auth.catch(error => {
      if (revision !== generation) return status();
      if (socket === ws) close();
      lastError = error.message;
      record('ws_auth', 'failed', started, 'transport_failed');
      publish();
      schedule(revision);
      return status();
    });
  }
  const ready = (async () => {
    const revision = generation;
    const stored = await storage.get(['remoteControlEnabled', 'remoteDeviceId', 'remoteHubUrl']);
    if (revision !== generation) return;
    config = stored;
    try { config.remoteHubUrl = validateHub(config.remoteHubUrl || hubUrl); }
    catch { config.remoteControlEnabled = false; lastError = 'Invalid saved Hub address'; }
    try { if (parsePairing(config.remoteDeviceId).origin !== config.remoteHubUrl) throw new Error(); }
    catch { config.remoteControlEnabled = false; }
    publish();
    void connect();
  })();
  function set({ enabled, rotate = false, hubUrl: requestedHub }) {
    let origin;
    try { origin = validateHub(requestedHub ?? config.remoteHubUrl ?? hubUrl); }
    catch (error) { return Promise.reject(error); }
    if (typeof enabled !== 'boolean' || typeof rotate !== 'boolean') return Promise.reject(new Error('Invalid switch state'));
    const revision = ++generation;
    // Fence the old socket immediately, even while an earlier connection is awaiting auth.
    close();
    config.remoteControlEnabled = false;
    const stopped = stopping = Promise.resolve(onStop());
    mutations = mutations.catch(() => {}).then(async () => {
      await stopped;
      if (revision !== generation) return status();
      let saved = await storage.get(['remoteDeviceId', 'remoteHubUrl']);
      let valid = false;
      try { valid = parsePairing(saved.remoteDeviceId).origin === origin; } catch {}
      if (!valid) saved = { remoteDeviceId: '' };
      if (enabled && (!valid || rotate)) saved = { remoteDeviceId: await createPairing(origin) };
      if (revision !== generation) return status();
      await storage.set({ ...saved, remoteHubUrl: origin, remoteControlEnabled: enabled });
      await storage.remove?.(['remoteSecret', 'remoteRouteId']);
      if (revision !== generation) return status();
      config = { ...saved, remoteHubUrl: origin, remoteControlEnabled: enabled };
      lastError = null;
      diagnostic = null;
      publish();
      return enabled ? connect() : status();
    });
    return mutations;
  }
  return { ready, status, set,
    reconnect: () => ready.then(() => {
      if (authenticated && heartbeat()) return status();
      if (authenticated) close();
      return connect();
    }),
    isConnected: () => authenticated && !!config.remoteControlEnabled,
    dispose: () => { generation++; close(); } };
}
