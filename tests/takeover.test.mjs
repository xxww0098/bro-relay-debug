import test from 'node:test';
import assert from 'node:assert/strict';
import { createTakeover } from '../extension/takeover.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const jpeg = 'data:image/jpeg;base64,AA==';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ createPromise, capturePromise, focusPromise } = {}) {
  const source = { id: 11, index: 5, title: 'Source page', url: 'https://source.test/', active: true };
  const tabs = new Map([[source.id, source]]);
  const calls = { create: [], update: [], remove: [], focus: [], focusEffects: [] };
  let nextId = 90;
  const onStop = [];
  const api = {
    get: async id => tabs.get(id) ? { ...tabs.get(id) } : undefined,
    create: async details => {
      calls.create.push(details);
      const tab = createPromise ? await createPromise : { id: nextId++ };
      tabs.set(tab.id, { ...tab, ...details });
      return { ...tabs.get(tab.id) };
    },
    update: async (id, details) => {
      if (!tabs.has(id)) throw new Error('No such tab');
      calls.update.push([id, details]);
      const tab = { ...tabs.get(id), ...details };
      tabs.set(id, tab);
      return tab;
    },
    remove: async id => {
      calls.remove.push(id);
      tabs.delete(id);
    },
    query: async () => [...tabs.values()].map(tab => ({ ...tab })),
  };
  const takeover = createTakeover({
    tabs: api,
    previewUrl: 'chrome-extension://test/preview.html',
    capture: async () => capturePromise ? await capturePromise : jpeg,
    setFocus: async (sourceId, enabled, signal) => {
      calls.focus.push([sourceId, enabled]);
      if (enabled && focusPromise) await focusPromise;
      if (!signal?.aborted || !enabled) calls.focusEffects.push([sourceId, enabled]);
    },
    onStop: (...args) => onStop.push(args),
  });
  return { takeover, source, tabs, calls, onStop };
}

test('enter captures the source, creates an adjacent preview, and activates it only if source stayed active', async t => {
  const h = harness();
  t.after(() => h.takeover.stopAll());
  const lease = await h.takeover.enter(h.source.id, new AbortController().signal);
  const created = h.calls.create[0];
  const previewId = [...h.tabs.keys()].find(id => id !== h.source.id);

  assert.equal(created.active, false);
  assert.equal(created.index, h.source.index + 1);
  assert.match(created.url, /^chrome-extension:\/\/test\/preview\.html/);
  assert.equal(new URL(created.url).searchParams.get('sourceTabId'), String(h.source.id));
  const preview = await h.takeover.read(previewId);
  assert.equal(preview.active, true);
  assert.equal(preview.title, h.source.title);
  assert.equal(preview.image, jpeg);
  assert.equal(typeof preview.capturedAt, 'number');

  await h.takeover.leave(lease);
  assert.deepEqual(h.calls.update, [[previewId, { active: true }], [h.source.id, { active: true }]]);
  assert.deepEqual(h.calls.remove, [previewId]);
  assert.equal((await h.takeover.read(previewId)).active, false);
  assert.equal(h.onStop.length, 0);
});

test('cancellation and stopAll clean up a preview created after the lease was stopped', async t => {
  const created = deferred();
  const h = harness({ createPromise: created.promise });
  t.after(() => h.takeover.stopAll());
  const controller = new AbortController();
  const entering = h.takeover.enter(h.source.id, controller.signal);
  await tick();
  controller.abort();
  h.takeover.stopAll();
  created.resolve({ id: 91 });
  await entering.catch(() => {});
  await tick();

  assert.deepEqual(h.calls.remove, [91]);
  assert.equal((await h.takeover.read(91)).active, false);
  assert.equal(h.onStop.length, 0);
});

test('leave closes an inactive preview without stealing the tab the user activated', async t => {
  const h = harness();
  t.after(() => h.takeover.stopAll());
  const lease = await h.takeover.enter(h.source.id, new AbortController().signal);
  const previewId = [...h.tabs.keys()].find(id => id !== h.source.id);
  h.tabs.set(previewId, { ...h.tabs.get(previewId), active: false });
  h.tabs.set(999, { id: 999, active: true, url: 'https://other.test/' });
  h.calls.update.length = 0;
  h.takeover.onActivated(999);

  await h.takeover.leave(lease);
  assert.deepEqual(h.calls.update, []);
  assert.deepEqual(h.calls.remove, [previewId]);
});

test('manual preview removal reports onStop, while programmatic stopAll does not', async t => {
  const manual = harness();
  t.after(() => manual.takeover.stopAll());
  await manual.takeover.enter(manual.source.id, new AbortController().signal);
  const manualPreview = [...manual.tabs.keys()].find(id => id !== manual.source.id);
  manual.takeover.onRemoved(manualPreview);
  assert.equal(manual.onStop.length, 1);
  await manual.takeover.stopAll();

  const stopped = harness();
  await stopped.takeover.enter(stopped.source.id, new AbortController().signal);
  stopped.takeover.stopAll();
  await tick();
  assert.equal(stopped.onStop.length, 0);
  assert.equal((await stopped.takeover.read(90)).active, false);
});

test('recover closes leftover previews and returns focus to an existing source', async () => {
  const h = harness();
  h.tabs.set(92, {
    id: 92,
    active: true,
    url: 'chrome-extension://test/preview.html?sourceTabId=11',
    title: 'Recovered preview',
  });
  h.tabs.set(93, {
    id: 93,
    active: true,
    url: 'chrome-extension://test/preview.html?sourceTabId=404',
    title: 'Orphan preview',
  });

  await h.takeover.recover();
  assert.equal(h.takeover.isPreview(92), false);
  assert.equal((await h.takeover.read(92)).active, false);
  assert.equal(h.takeover.isPreview(93), false);
  assert.equal((await h.takeover.read(404)).active, false);
  assert.deepEqual(h.calls.update, [[h.source.id, { active: true }]]);
  assert.deepEqual(h.calls.remove, [92, 93]);
  assert.deepEqual(h.calls.focus[0], [h.source.id, false]);
  await h.takeover.stopAll();
});

test('stopAll interrupts a capture that never resolves', async t => {
  const h = harness({ capturePromise: new Promise(() => {}) });
  t.after(() => h.takeover.stopAll());
  const entering = h.takeover.enter(h.source.id, new AbortController().signal);
  await tick();

  const stopped = await Promise.race([
    h.takeover.stopAll().then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(stopped, true);
  await entering.catch(() => {});
  assert.deepEqual(h.calls.create, []);
});

test('switching away during capture leaves the preview inactive', async t => {
  const captured = deferred();
  const h = harness({ capturePromise: captured.promise });
  t.after(() => h.takeover.stopAll());
  const entering = h.takeover.enter(h.source.id, new AbortController().signal);
  await tick();
  h.source.active = false;
  h.tabs.set(999, { id: 999, active: true, url: 'https://other.test/' });
  h.takeover.onActivated(999);
  captured.resolve(jpeg);
  const lease = await entering;
  const previewId = [...h.tabs.keys()].find(id => id !== h.source.id && id !== 999);

  assert.equal(h.calls.create[0].active, false);
  assert.deepEqual(h.calls.update, []);
  await h.takeover.leave(lease);
  assert.deepEqual(h.calls.remove, [previewId]);
});

test('cancelling while focus attach is pending prevents a late focus enable', async t => {
  const attached = deferred();
  const h = harness({ focusPromise: attached.promise });
  t.after(() => h.takeover.stopAll());
  const controller = new AbortController();
  const entering = h.takeover.enter(h.source.id, controller.signal);
  await tick();
  assert.deepEqual(h.calls.focus, [[h.source.id, true]]);

  controller.abort();
  await entering.catch(() => {});
  attached.resolve();
  await tick();
  assert.deepEqual(h.calls.focusEffects, [[h.source.id, false]]);
  assert.deepEqual(h.calls.create, []);
});
