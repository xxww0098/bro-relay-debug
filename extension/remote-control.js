// Owns the persisted switch/credential and exactly one authenticated socket.
export function createRemoteControl({ storage, hubUrl, hello, onRequest, onStop, onStatus = () => {}, socketFactory = url => new WebSocket(url) }) {
  let config = {}, generation = 0, socket, authenticated = false, connecting, connectionAbort;
  let reconnectTimer, heartbeatTimer, rejectConnect, mutations = Promise.resolve(), stopping = Promise.resolve();
  let lastError = null, attempt = 0;
  const status = () => ({ enabled: !!config.remoteControlEnabled, connected: authenticated,
    deviceId: config.remoteDeviceId || '', lastError });
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
  function schedule(revision) {
    if (revision !== generation || !config.remoteControlEnabled || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempt++, 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delay);
  }
  async function connect() {
    await stopping;
    if (!config.remoteControlEnabled) return status();
    if (authenticated) return status();
    if (connecting) return connecting;
    const revision = generation;
    const wsUrl = new URL('/v1/device/connect', hubUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('routeId', config.remoteRouteId);
    const ws = socketFactory(wsUrl.href);
    const abort = new AbortController();
    connectionAbort = abort;
    socket = ws;
    const current = () => revision === generation && socket === ws && config.remoteControlEnabled;
    const sendHello = () => ws.send(JSON.stringify({ type: 'device.hello', ...hello }));
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
          attempt = 0;
          sendHello();
          // MV3 needs periodic traffic; merely keeping a WebSocket open is insufficient.
          heartbeatTimer = setInterval(() => { if (current() && authenticated) sendHello(); }, 20000);
          publish();
          resolve(status());
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
    const pending = auth.catch(error => {
      if (revision !== generation) return status();
      if (socket === ws) close();
      lastError = error.message;
      publish();
      schedule(revision);
      return status();
    }).finally(() => { if (connecting === pending) connecting = undefined; });
    connecting = pending;
    return pending;
  }
  const ready = (async () => {
    const revision = generation;
    const stored = await storage.get(['remoteControlEnabled', 'remoteSecret', 'remoteRouteId', 'remoteDeviceId']);
    if (revision !== generation) return;
    config = stored;
    if (!config.remoteSecret || !config.remoteRouteId) config.remoteControlEnabled = false;
    publish();
    void connect();
  })();
  function set({ enabled, rotate = false }) {
    if (typeof enabled !== 'boolean' || typeof rotate !== 'boolean') return Promise.reject(new Error('Invalid switch state'));
    const revision = ++generation;
    // Fence the old socket immediately, even while an earlier connection is awaiting auth.
    close();
    config.remoteControlEnabled = false;
    const stopped = stopping = Promise.resolve(onStop());
    mutations = mutations.catch(() => {}).then(async () => {
      await stopped;
      if (revision !== generation) return status();
      let saved = await storage.get(['remoteSecret', 'remoteRouteId', 'remoteDeviceId']);
      if (enabled && (!saved.remoteSecret || rotate)) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
        saved = { remoteSecret: secret, remoteDeviceId: `br-${secret}`,
          remoteRouteId: btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16) };
      }
      if (revision !== generation) return status();
      await storage.set({ ...saved, remoteControlEnabled: enabled });
      if (revision !== generation) return status();
      config = { ...saved, remoteControlEnabled: enabled };
      lastError = null;
      publish();
      return enabled ? connect() : status();
    });
    return mutations;
  }
  return { ready, status, set, reconnect: () => ready.then(connect),
    isConnected: () => authenticated && !!config.remoteControlEnabled,
    dispose: () => { generation++; close(); } };
}
