import { validateHub } from './hub-url.js';
// Owns the persisted switch/credential and exactly one authenticated socket.
export function createRemoteControl({ storage, hubUrl, hello, onRequest, onStop, onStatus = () => {}, hasPermission = async () => true, socketFactory = url => new WebSocket(url) }) {
  let config = {}, generation = 0, socket, authenticated = false, connecting, connectionAbort;
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
    socket.send(JSON.stringify({ type: 'device.hello', ...hello }));
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
    const pending = connectOnce().finally(() => { if (connecting === pending) connecting = undefined; });
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
    const started = Date.now();
    record('ws_auth', 'pending', started);
    const wsUrl = new URL('/v1/device/connect', origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('routeId', config.remoteRouteId);
    const ws = socketFactory(wsUrl.href);
    const abort = new AbortController();
    connectionAbort = abort;
    socket = ws;
    const current = () => revision === generation && socket === ws && config.remoteControlEnabled;
    const auth = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hub connection timed out')), 8000);
      rejectConnect = error => { clearTimeout(timer); reject(error); };
      ws.onopen = () => { if (current()) ws.send(JSON.stringify({ type: 'device.auth', secret: config.remoteSecret })); };
      ws.onerror = () => { if (current()) rejectConnect?.(new Error('Hub connection failed')); };
      ws.onclose = () => {
        if (!current()) return;
        abort.abort();
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
        try { message = JSON.parse(String(event.data)); } catch { return; }
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
        if (message.type !== 'rpc.request') return;
        void (async () => {
          if (!current() || !authenticated) return;
          let response;
          try { response = await onRequest(message, abort.signal); }
          catch (error) { response = { status: 500, body: { ok: false, code: 'remote_exec_failed', message: error.message } }; }
          if (current() && authenticated) ws.send(JSON.stringify({ type: 'rpc.response', id: message.id, ...response }));
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
    const stored = await storage.get(['remoteControlEnabled', 'remoteSecret', 'remoteRouteId', 'remoteDeviceId', 'remoteHubUrl']);
    if (revision !== generation) return;
    config = stored;
    try { config.remoteHubUrl = validateHub(config.remoteHubUrl || hubUrl); }
    catch { config.remoteControlEnabled = false; lastError = 'Invalid saved Hub address'; }
    if (!config.remoteSecret || !config.remoteRouteId) config.remoteControlEnabled = false;
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
      let saved = await storage.get(['remoteSecret', 'remoteRouteId', 'remoteDeviceId', 'remoteHubUrl']);
      if (origin !== (saved.remoteHubUrl || hubUrl)) {
        saved = { remoteSecret: '', remoteRouteId: '', remoteDeviceId: '' };
      }
      if (enabled && (!saved.remoteSecret || rotate)) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
        saved = { remoteSecret: secret, remoteDeviceId: `br-${secret}`,
          remoteRouteId: btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16) };
      }
      if (revision !== generation) return status();
      await storage.set({ ...saved, remoteHubUrl: origin, remoteControlEnabled: enabled });
      if (revision !== generation) return status();
      config = { ...saved, remoteHubUrl: origin, remoteControlEnabled: enabled };
      lastError = null;
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
