// Browser execution derives from Browser Relay (MIT); transport is remote-only.
import { HUB_URL } from './config.js';
import { createRemoteControl } from './remote-control.js';
import { createAutomation } from './automation.js';
import { isAutomationPath, PROTOCOL_VERSION, FEATURES } from './protocol.js';
import { checkCancelled } from './tasks.js';
import { createTakeover } from './takeover.js';

const runtimeId = crypto.randomUUID();
const executorInfo = () => ({ extensionVersion: chrome.runtime.getManifest().version, runtimeId, protocolVersion: PROTOCOL_VERSION, features: FEATURES });
const tabs = new Map(), attachPromises = new Map(), publicTabIds = new Map(), issuedPublicTabIds = new Set();
const PUBLIC_TAB_ID_PATTERN = /^t_[A-Za-z0-9_-]{10}$/;
const isAttachableUrl = url => /^(https?:\/\/|about:blank$)/.test(url || '');

function publicTabIdFor(tabId) {
  if (!publicTabIds.has(tabId)) {
    let id;
    do {
      id = 't_' + Array.from(crypto.getRandomValues(new Uint8Array(10)), n => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[n & 63]).join('');
    } while (issuedPublicTabIds.has(id));
    issuedPublicTabIds.add(id);
    publicTabIds.set(tabId, id);
    tabIdsDirty = true;
  }
  return publicTabIds.get(tabId);
}
let tabIdsDirty = false;
function persistState() {
  // A stable public id only needs writing when the mapping actually changed;
  // listing tabs is a read command and should stay one.
  if (!tabIdsDirty) return Promise.resolve();
  tabIdsDirty = false;
  return chrome.storage.session.set({ publicTabIds: [...publicTabIds], issuedPublicTabIds: [...issuedPublicTabIds] });
}
const ready = (async () => {
  const saved = await chrome.storage.session.get(['publicTabIds', 'issuedPublicTabIds']);
  for (const id of saved.issuedPublicTabIds || []) if (PUBLIC_TAB_ID_PATTERN.test(id)) issuedPublicTabIds.add(id);
  for (const [tabId, id] of saved.publicTabIds || []) {
    if (!Number.isInteger(tabId) || !PUBLIC_TAB_ID_PATTERN.test(id) || [...publicTabIds.values()].includes(id)) continue;
    try { await chrome.tabs.get(tabId); publicTabIds.set(tabId, id); issuedPublicTabIds.add(id); } catch { /* Closed while suspended. */ }
  }
})();
// Structured so the CLI can report a bad tab id as a 404 instead of a 500.
const relayError = (code, message, status) => Object.assign(new Error(message), { code, status });
async function resolveRemoteTabId(id) {
  await ready;
  for (const [tabId, publicId] of publicTabIds) {
    if (id !== publicId) continue;
    const tab = await chrome.tabs.get(tabId);
    if (!isAttachableUrl(tab.url)) throw relayError('tab_not_found', 'Page is no longer controllable', 404);
    return tabId;
  }
  throw relayError('tab_not_found', 'Unknown or missing tabId; list tabs again', 404);
}
async function ensureRemoteAttached(tabId) {
  if (!control.isConnected()) throw relayError('remote_control_disabled', 'Remote control is disabled or disconnected', 409);
  if (tabs.has(tabId)) { tabs.get(tabId).lastActivity = Date.now(); return; }
  if (attachPromises.has(tabId)) return attachPromises.get(tabId);
  const pending = (async () => {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (error) {
      // A surviving attachment after MV3 suspension belongs to us only if a probe succeeds.
      try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true }); }
      catch { throw error; }
    }
    if (!control.isConnected()) { await chrome.debugger.detach({ tabId }).catch(() => {}); throw new Error('Remote control stopped'); }
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    tabs.set(tabId, { state: 'connected', lastActivity: Date.now() });
    consoleCaptureTabs.delete(tabId); networkCaptureTabs.delete(tabId);
  })();
  attachPromises.set(tabId, pending);
  try { await pending; } finally { attachPromises.delete(tabId); }
}
async function remoteCdp(tabId, method, params, sessionId, signal) {
  checkCancelled(signal);
  await ensureRemoteAttached(tabId);
  checkCancelled(signal);
  if (!control.isConnected()) throw new Error('Remote control stopped');
  return chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params || {});
}
async function stopControl() {
  automation.cancelAll();
  automation.disconnect('remote');
  await takeover.stopAll();
  await Promise.allSettled([...attachPromises.values()]);
  await Promise.allSettled([...tabs.keys()].map(tabId => chrome.debugger.detach({ tabId })));
  for (const tabId of tabs.keys()) automation.close(tabId);
  tabs.clear();
  consoleCaptureTabs.clear(); networkCaptureTabs.clear();
  consoleEntries = []; networkEntries = [];
}
async function apiListTabs() {
  await ready;
  const result = [];
  for (const tab of await chrome.tabs.query({})) {
    if (isAttachableUrl(tab.url)) result.push({ id: publicTabIdFor(tab.id), title: tab.title || '', url: tab.url, attached: tabs.has(tab.id) });
  }
  await persistState();
  return { ok: true, tabs: result };
}
async function executeRemoteApi(method, path, body, signal) {
  await ready;
  await takeoverReady;
  checkCancelled(signal);
  if (!control.isConnected()) throw new Error('Remote control stopped');
  const url = new URL(path, 'http://relay.local');
  const payload = body || {};
  if (isAutomationPath(url.pathname)) {
    try {
      const result = await automation.request(method, path, payload, 'remote', signal);
      return { status: result.ok === false ? result.status || 400 : 200, body: result };
    } catch (error) {
      return { status: error.status || 500, body: { ok: false, code: error.code || 'automation_failed', message: error.message,
        taskId: payload.taskId || url.searchParams.get('taskId') || undefined } };
    }
  }
  if (method !== 'GET') throw new Error('Use the task-aware /api/actions or /api/evaluate endpoint');
  if (url.pathname === '/api/tabs') return { status: 200, body: await apiListTabs() };
  const tabId = await resolveRemoteTabId(payload.tabId ?? url.searchParams.get('tabId'));
  checkCancelled(signal);
  automation.sessions.check(tabId, undefined);
  const handlers = { '/api/screenshot': apiScreenshot, '/api/console': apiConsole, '/api/network': apiNetwork };
  if (!handlers[url.pathname]) throw new Error('Unknown API endpoint');
  return { status: 200, body: await handlers[url.pathname](payload, url.searchParams) };
}
function base64Bytes(d) {
  const len = String(d || '').length
  if (!len) return 0
  const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0
  return Math.floor(len * 3 / 4) - pad
}

async function apiScreenshot(body, searchParams) {
  const tabId = await resolveRemoteTabId(body.tabId ?? searchParams.get('tabId'))
  const fullPage = body.fullPage === true || searchParams.get('fullPage') === 'true'
  // The page-local action hint is operator feedback, never part of the evidence.
  await automation.dismissOverlay(tabId)

  if (fullPage) {
    let width = null, height = null, fallbackError = null
    try {
      const metrics = await remoteCdp(tabId, 'Page.getLayoutMetrics', {})
      const size = metrics?.cssContentSize || metrics?.contentSize || metrics?.cssLayoutViewport || metrics?.layoutViewport
      const rw = Number(size?.width), rh = Number(size?.height)
      if (Number.isFinite(rw) && Number.isFinite(rh) && rw > 0 && rh > 0) {
        width = Math.ceil(rw); height = Math.ceil(rh)
        const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })
        const data = r?.data || ''
        return { ok: true, data, format: 'png', fullPage: true, strategy: 'fullPageClip', width, height, bytes: base64Bytes(data) }
      }
    } catch (err) { fallbackError = err instanceof Error ? err.message : String(err) }
    const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const data = r?.data || ''
    return { ok: true, data, format: 'png', fullPage: true, strategy: 'captureBeyondViewport', width, height, bytes: base64Bytes(data), fallbackError }
  }

  const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = r?.data || ''
  return { ok: true, data, format: 'png', fullPage: false, strategy: 'viewport', bytes: base64Bytes(data) }
}

const MAX_CONSOLE_ENTRIES = 1000
const MAX_NETWORK_ENTRIES = 1000
const SENSITIVE_NETWORK_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-auth-token'])
let consoleEntries = []
let networkEntries = []
let nextConsoleEntryId = 1
let nextNetworkEntryId = 1
const consoleCaptureTabs = new Set()
const networkCaptureTabs = new Set()

function boundInt(value, dflt, min, max) {
  const n = parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

function remoteObjectValue(obj) {
  if (!obj || typeof obj !== 'object') return ''
  if ('value' in obj) return obj.value
  if ('unserializableValue' in obj) return obj.unserializableValue
  return obj.description || obj.type || ''
}

function stringifyConsoleValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try { return JSON.stringify(value) } catch { return String(value) }
}

function redactNetworkHeaders(headers = {}) {
  const redacted = {}
  if (!headers || typeof headers !== 'object') return redacted
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_NETWORK_HEADERS.has(String(name).toLowerCase()) ? '[redacted]' : value
  }
  return redacted
}

function appendConsoleEntry(entry) {
  consoleEntries.push({ id: nextConsoleEntryId++, receivedAt: new Date().toISOString(), ...entry })
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries = consoleEntries.slice(-MAX_CONSOLE_ENTRIES)
}

function appendNetworkEntry(entry) {
  networkEntries.push({ id: nextNetworkEntryId++, receivedAt: new Date().toISOString(), ...entry })
  if (networkEntries.length > MAX_NETWORK_ENTRIES) networkEntries = networkEntries.slice(-MAX_NETWORK_ENTRIES)
}

// Called from onDebuggerEvent for every attached tab; tabId is the chrome tab id.
function captureCdpEvent(tabId, method, params = {}) {
  const base = { tabId: publicTabIdFor(tabId) }

  if (method === 'Runtime.consoleAPICalled') {
    const args = (params.args || []).map(remoteObjectValue)
    return appendConsoleEntry({ ...base, source: 'runtime', level: params.type || 'log', text: args.map(stringifyConsoleValue).join(' '), args, stackTrace: params.stackTrace || null, timestamp: params.timestamp || null })
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {}
    return appendConsoleEntry({ ...base, source: 'runtime', level: 'error', text: details.exception?.description || details.text || 'Uncaught exception', exceptionDetails: details, timestamp: params.timestamp || null })
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry || {}
    return appendConsoleEntry({ ...base, source: entry.source || 'log', level: entry.level || 'info', text: entry.text || '', lineNumber: entry.lineNumber, url: entry.url || '', networkRequestId: entry.networkRequestId, timestamp: entry.timestamp || null })
  }

  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {}
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'request', url: request.url || params.documentURL || '', method: request.method || '', documentURL: params.documentURL || '', frameId: params.frameId || '', resourceType: params.type || '', wallTime: params.wallTime ?? null, timestamp: params.timestamp ?? null, initiator: params.initiator || null, request: { url: request.url || '', method: request.method || '', headers: redactNetworkHeaders(request.headers) } })
  }
  if (method === 'Network.responseReceived') {
    const response = params.response || {}
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'response', url: response.url || '', status: response.status ?? null, statusText: response.statusText || '', mimeType: response.mimeType || '', protocol: response.protocol || '', resourceType: params.type || '', timestamp: params.timestamp ?? null, response: { url: response.url || '', status: response.status ?? null, statusText: response.statusText || '', headers: redactNetworkHeaders(response.headers), mimeType: response.mimeType || '' } })
  }
  if (method === 'Network.loadingFinished') {
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'finished', encodedDataLength: params.encodedDataLength ?? null, timestamp: params.timestamp ?? null })
  }
  if (method === 'Network.loadingFailed') {
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'failed', resourceType: params.type || '', errorText: params.errorText || '', canceled: !!params.canceled, blockedReason: params.blockedReason || '', timestamp: params.timestamp ?? null })
  }
}

async function ensureConsoleCapture(tabId) {
  if (consoleCaptureTabs.has(tabId)) return
  await ensureRemoteAttached(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {})
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable').catch(() => {})
  consoleCaptureTabs.add(tabId)
}

async function ensureNetworkCapture(tabId) {
  if (networkCaptureTabs.has(tabId)) return
  await ensureRemoteAttached(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => {})
  networkCaptureTabs.add(tabId)
}

function attachedTabIds() {
  const ids = []
  for (const [id, tab] of tabs.entries()) if (tab.state === 'connected') ids.push(id)
  return ids
}

async function apiConsole(body, params) {
  const tabIdParam = body.tabId ?? params.get('tabId')
  const level = body.level ?? params.get('level')
  const limit = boundInt(body.limit ?? params.get('limit'), 100, 0, MAX_CONSOLE_ENTRIES)
  const clear = String(body.clear ?? params.get('clear')) === 'true'

  if (tabIdParam !== undefined && tabIdParam !== null && tabIdParam !== '') {
    await ensureConsoleCapture(await resolveRemoteTabId(tabIdParam)).catch(() => {})
  } else {
    await Promise.all(attachedTabIds().map((id) => ensureConsoleCapture(id).catch(() => {})))
  }

  let entries = consoleEntries
  if (tabIdParam) entries = entries.filter((e) => String(e.tabId) === String(tabIdParam))
  if (level) entries = entries.filter((e) => e.level === level)
  const total = entries.length
  const selected = limit === 0 ? [] : entries.slice(-limit)
  if (clear) { const ids = new Set(selected.map((e) => e.id)); consoleEntries = consoleEntries.filter((e) => !ids.has(e.id)) }
  return { ok: true, entries: selected, count: selected.length, total, storedTotal: consoleEntries.length }
}

function filterNetwork(entries, f) {
  let out = entries
  if (f.tabId) out = out.filter((e) => String(e.tabId) === String(f.tabId))
  if (f.type) out = out.filter((e) => e.type === f.type)
  if (f.method) out = out.filter((e) => String(e.method || e.request?.method || '').toUpperCase() === String(f.method).toUpperCase())
  if (f.status) out = out.filter((e) => Number(e.status ?? e.response?.status) === Number(f.status))
  if (f.requestId) out = out.filter((e) => e.requestId === f.requestId)
  if (f.url) out = out.filter((e) => String(e.url || e.request?.url || e.response?.url || '').includes(f.url))
  return out
}

async function apiNetwork(body, params) {
  const f = {
    tabId: body.tabId ?? params.get('tabId') ?? undefined,
    type: body.type ?? params.get('type') ?? undefined,
    method: body.method ?? params.get('method') ?? undefined,
    status: body.status ?? params.get('status') ?? undefined,
    requestId: body.requestId ?? params.get('requestId') ?? undefined,
    url: body.url ?? params.get('url') ?? undefined,
  }
  const limit = boundInt(body.limit ?? params.get('limit'), 100, 0, MAX_NETWORK_ENTRIES)
  const clear = String(body.clear ?? params.get('clear')) === 'true'

  if (f.tabId) await ensureNetworkCapture(await resolveRemoteTabId(f.tabId)).catch(() => {})
  else await Promise.all(attachedTabIds().map((id) => ensureNetworkCapture(id).catch(() => {})))

  const matched = filterNetwork(networkEntries, f)
  const selected = limit === 0 ? [] : matched.slice(-limit)
  if (clear) { const ids = new Set(selected.map((e) => e.id)); networkEntries = networkEntries.filter((e) => !ids.has(e.id)) }
  return { ok: true, entries: selected, count: selected.length, total: matched.length, storedTotal: networkEntries.length }
}

const takeover = createTakeover({
  tabs: chrome.tabs,
  previewUrl: chrome.runtime.getURL('preview.html'),
  setFocus: (tabId, enabled, signal) => enabled
    ? remoteCdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled }, undefined, signal)
    : chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled }),
  capture: async (tabId, signal) => {
    await automation?.dismissOverlay(tabId);
    const frame = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false }, undefined, signal);
    return `data:image/jpeg;base64,${frame.data}`;
  },
  measure: async (tabId, signal) => {
    const metrics = await remoteCdp(tabId, 'Page.getLayoutMetrics', {}, undefined, signal);
    const view = metrics?.cssLayoutViewport || metrics?.layoutViewport;
    const width = Number(view?.clientWidth), height = Number(view?.clientHeight);
    return width > 0 && height > 0 ? { width, height } : null;
  },
  onStop: () => control.set({ enabled: false }),
});
const takeoverReady = takeover.recover();
let automation = createAutomation({
  runtimeInfo: executorInfo, publicTabId: publicTabIdFor, resolveTab: resolveRemoteTabId,
  send: remoteCdp,
  beginTask: takeover.enter,
  endTask: takeover.leave,
  endPreview: takeover.leaveSource,
  onPointer: (tabId, pointer) => takeover.setPointer(tabId, pointer),
  onViewport: (tabId, viewport) => takeover.setViewport(tabId, viewport),
  createTab: async url => {
    if (!isAttachableUrl(url)) throw new Error('Only HTTP(S) and about:blank are supported');
    if (!control.isConnected()) throw new Error('Remote control stopped');
    const tab = await chrome.tabs.create({ url, active: false });
    const tabId = publicTabIdFor(tab.id);
    await persistState();
    return { tabId, url };
  },
  closeTab: tabId => chrome.tabs.remove(tabId),
  focusTab: async (tabId, signal) => {
    const tab = await chrome.tabs.get(tabId);
    checkCancelled(signal);
    await chrome.windows.update(tab.windowId, { focused: true });
    checkCancelled(signal);
    await chrome.tabs.update(takeover.previewFor(tabId) ?? tabId, { active: true });
  },
});
const control = createRemoteControl({
  storage: chrome.storage.local, hubUrl: HUB_URL,
  hello: { version: chrome.runtime.getManifest().version, protocolVersion: PROTOCOL_VERSION, deviceName: 'Bro Relay Debug', capabilities: FEATURES, executor: executorInfo() },
  onRequest: (message, signal) => executeRemoteApi(message.method, message.path, message.body, signal),
  onStop: stopControl,
  onStatus: state => {
    if (state.enabled) void ensureOffscreen();
    else void chrome.offscreen?.closeDocument?.().catch(() => {});
    void chrome.action.setBadgeText({ text: state.connected ? 'ON' : state.enabled ? '…' : '' });
    void chrome.action.setBadgeBackgroundColor({ color: state.connected ? '#318244' : '#b7771a' });
    void chrome.runtime.sendMessage({ type: 'remoteStatusChanged', ...state }).catch(() => {});
  },
});
async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) return;
  try {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) ?? [];
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keep the hub WebSocket alive while the service worker is idle',
    });
  } catch { /* Already created, or this browser has no offscreen documents. */ }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'bro-keepalive') {
    void control.reconnect();
    return false;
  }
  if (message?.type === 'getTakeoverPreview') {
    takeover.read(sender.tab?.id).then(respond);
    return true;
  }
  if (message?.type === 'stopTakeover' && takeover.isPreview(sender.tab?.id)) {
    control.set({ enabled: false }).then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (message?.type === 'setRemoteControl') {
    control.set({ enabled: message.enabled, rotate: message.rotate ?? false }).then(respond, error => respond({ ...control.status(), lastError: error.message }));
    return true;
  }
  if (message?.type === 'getRemoteControlStatus') {
    control.ready.then(() => respond(control.status()));
    return true;
  }
  return false;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (method === 'Page.frameNavigated' && !params.frame?.parentId) automation.invalidate(source.tabId);
  if (method === 'Target.attachedToTarget') automation.attachChild(source.tabId, params);
  if (method === 'Target.detachedFromTarget') automation.detachChild(source.tabId, params.sessionId);
  if (control.isConnected()) captureCdpEvent(source.tabId, method, params);
});
chrome.debugger.onDetach.addListener(({ tabId }) => {
  tabs.delete(tabId);
  consoleCaptureTabs.delete(tabId); networkCaptureTabs.delete(tabId);
  automation.close(tabId);
  void takeover.onRemoved(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => void takeover.onActivated(tabId));
chrome.tabs.onRemoved.addListener(tabId => {
  if (publicTabIds.delete(tabId)) tabIdsDirty = true;
  tabs.delete(tabId);
  automation.close(tabId);
  void takeover.onRemoved(tabId);
  void persistState();
});
chrome.alarms.create('bro-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'bro-keepalive') return;
  if (control.status().enabled) await ensureOffscreen();
  automation.sessions.sweep();
  await control.reconnect();
  for (const [tabId, state] of tabs) {
    if (Date.now() - state.lastActivity > 600000 && !automation.activeTasks().some(task => task.tabId === tabId)) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
});
