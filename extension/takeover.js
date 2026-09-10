import { checkCancelled } from './tasks.js';

// Preview tabs contain pixels only. Browser input is never forwarded to the source.
// The operator-facing pointer is drawn on the preview itself: a background
// page throttles CSS animation, and screenshots are too slow to look like a mouse.
export function createTakeover({ tabs, previewUrl, capture, onStop, setFocus = async () => {}, measure } = {}) {
  const sources = new Map(), previews = new Map();
  function live(sourceId) {
    const lease = sources.get(sourceId);
    return lease && !lease.closing ? lease : null;
  }
  async function snapshot(lease, signal) {
    const image = await capture(lease.sourceId, signal);
    let viewport = lease.viewport;
    if (measure) {
      try {
        const next = await measure(lease.sourceId, signal);
        if (next?.width > 0 && next?.height > 0) viewport = { width: next.width, height: next.height };
      } catch { /* Keep the last known CSS viewport. */ }
    }
    return { image, viewport };
  }
  async function refresh(lease) {
    if (lease.closing || lease.capturing) return;
    lease.capturing = true;
    try {
      if (!(await tabs.get(lease.previewId)).active) return;
      const shot = await snapshot(lease, lease.controller.signal);
      if (!lease.closing) Object.assign(lease, { ...shot, capturedAt: Date.now(), error: undefined });
    } catch {
      if (!lease.closing) lease.error = '画面暂未更新';
    } finally { lease.capturing = false; }
  }
  async function enter(sourceId, signal) {
    checkCancelled(signal);
    const lease = { sourceId, closing: false, controller: new AbortController(), pointer: null, viewport: null };
    const interrupted = signal ? AbortSignal.any([signal, lease.controller.signal]) : lease.controller.signal;
    if (sources.has(sourceId)) throw new Error('Page already has a running takeover');
    sources.set(sourceId, lease);
    const check = () => {
      checkCancelled(interrupted);
      if (lease.closing) throw new Error('Takeover stopped');
    };
    lease.ready = (async () => {
      const source = await tabs.get(sourceId);
      check();
      lease.title = source.title || '页面预览';
      let rejectCapture;
      const cancelled = new Promise((_, reject) => { rejectCapture = () => reject(new Error('Takeover stopped')); });
      interrupted.addEventListener('abort', rejectCapture, { once: true });
      try {
        const shot = await Promise.race([(async () => {
          await setFocus(sourceId, true, interrupted);
          check();
          return snapshot(lease, interrupted);
        })(), cancelled]);
        lease.image = shot.image;
        if (shot.viewport) lease.viewport = shot.viewport;
      }
      finally { interrupted.removeEventListener('abort', rejectCapture); }
      lease.capturedAt = Date.now();
      check();
      const url = new URL(previewUrl);
      url.searchParams.set('sourceTabId', String(sourceId));
      const preview = await tabs.create({ url: url.href, windowId: source.windowId, index: source.index + 1, active: false });
      lease.previewId = preview.id;
      previews.set(preview.id, lease);
      check();
      const current = await tabs.get(sourceId);
      check();
      if (current.active) await tabs.update(preview.id, { active: true });
      check();
      lease.timer = setInterval(() => void refresh(lease), 1000);
    })();
    try { await lease.ready; check(); return lease; }
    catch (error) { await leave(lease); throw error; }
  }
  function leave(lease) {
    if (lease.finished) return lease.finished;
    lease.closing = true;
    lease.pointer = null;
    lease.controller.abort();
    clearInterval(lease.timer);
    lease.finished = (async () => {
      await lease.ready.catch(() => {});
      // Dispatch cleanup without waiting on a potentially unresponsive renderer.
      void setFocus(lease.sourceId, false).catch(() => {});
      if (sources.get(lease.sourceId) === lease) sources.delete(lease.sourceId);
      if (lease.previewId === undefined) return;
      previews.delete(lease.previewId);
      const preview = await tabs.get(lease.previewId).catch(() => null);
      if (preview?.active) await tabs.update(lease.sourceId, { active: true }).catch(() => {});
      await tabs.remove(lease.previewId).catch(() => {});
    })();
    return lease.finished;
  }
  return {
    enter, leave,
    stopAll: () => Promise.allSettled([...sources.values()].map(leave)),
    read: async previewId => {
      if (!previews.has(previewId)) await Promise.allSettled([...sources.values()].map(lease => lease.ready));
      const lease = previews.get(previewId);
      return lease && !lease.closing
        ? { active: true, title: lease.title, image: lease.image, capturedAt: lease.capturedAt, error: lease.error, pointer: lease.pointer, viewport: lease.viewport }
        : { active: false };
    },
    setPointer(sourceId, pointer) {
      const lease = live(sourceId);
      if (!lease) return;
      lease.pointer = pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
        ? { ...pointer, at: Date.now() } : null;
    },
    setViewport(sourceId, viewport) {
      const lease = live(sourceId);
      if (lease && viewport?.width > 0 && viewport?.height > 0) lease.viewport = { width: viewport.width, height: viewport.height };
    },
    leaveSource: sourceId => {
      const lease = sources.get(sourceId);
      return lease ? leave(lease) : Promise.resolve();
    },
    isPreview: tabId => previews.has(tabId),
    previewFor: sourceId => sources.get(sourceId)?.previewId,
    onActivated: async tabId => {
      const lease = sources.get(tabId);
      if (lease?.previewId !== undefined && !lease.closing)
        await tabs.update(lease.previewId, { active: true }).catch(() => {});
    },
    onRemoved: async tabId => {
      if (previews.has(tabId)) { await onStop(); return; }
      const lease = sources.get(tabId);
      if (lease) await leave(lease);
    },
    recover: async () => {
      for (const tab of await tabs.query({})) {
        if (!tab.url?.startsWith(`${previewUrl}?`)) continue;
        const sourceId = Number(new URL(tab.url).searchParams.get('sourceTabId'));
        if (Number.isSafeInteger(sourceId) && sourceId > 0) {
          void setFocus(sourceId, false).catch(() => {});
          if (tab.active) await tabs.update(sourceId, { active: true }).catch(() => {});
        }
        await tabs.remove(tab.id).catch(() => {});
      }
    },
  };
}
