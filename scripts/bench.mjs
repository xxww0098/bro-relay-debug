// Dev harness: measures command latency and per-command CDP call counts.
// Not part of the published package; run with `npm run bench`.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createBrowser } from '../cli/sdk.js'
import { createMockHub } from '../tests/fixtures/mock-hub.mjs'
import { build } from './build.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const fixture = join(root, 'tests/fixtures/remote-page.html')
const built = await build(root)
const hub = await createMockHub()
const framePage = '<!doctype html><meta charset="utf-8"><title>frame host</title><h1>host</h1><iframe src="/?inner=1" style="margin-top:200px;width:420px;height:260px"></iframe>'
// 1500 labelled rows with buttons and links: a page where the accessibility tree,
// not the round trip, dominates an observation.
const largePage = '<!doctype html><meta charset="utf-8"><title>large fixture</title><button id="apply">Apply</button>' + Array.from({ length: 60 }, (_, s) =>
  `<section aria-label="Section ${s}"><h2>Section ${s}</h2>` + Array.from({ length: 25 }, (_, r) =>
    `<div role="group" aria-label="Row ${s}-${r}"><span>Label ${s}-${r}</span><button>Action ${s}-${r}</button><a href="/doc/${s}/${r}">Open ${s}-${r}</a></div>`).join('') + '</section>').join('')
const pageServer = createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(req.url === '/frame' ? framePage : req.url === '/large' ? largePage : await readFile(fixture))
})
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`
const extension = await mkdtemp(join(tmpdir(), 'bro-relay-bench-'))
await cp(built.extension, extension, { recursive: true })

// Count every chrome.debugger.sendCommand in the copied worker.
const backgroundPath = join(extension, 'background.js')
const background = await readFile(backgroundPath, 'utf8')
const instrumented = `const __cdpStats = globalThis.__cdpStats = { total: 0, byMethod: {} };
const __countSend = (target, method, params) => { __cdpStats.total++; __cdpStats.byMethod[method] = (__cdpStats.byMethod[method] || 0) + 1; return chrome.debugger.sendCommand(target, method, params); };
const __tabsStats = globalThis.__tabsStats = { query: 0 };
const __countTabsQuery = (query) => { __tabsStats.query++; return chrome.tabs.query(query); };
` + background.replaceAll('chrome.debugger.sendCommand(', '__countSend(').replaceAll('chrome.tabs.query(', '__countTabsQuery(')
// BENCH_NO_TAKEOVER isolates the command path from the preview-tab feature, which
// opens its own tab and screenshot around every POST task.
const noTakeover = process.env.BENCH_NO_TAKEOVER === '1'
const isolated = instrumented.replace('beginTask: takeover.enter', 'beginTask: undefined').replace('endTask: takeover.leave', 'endTask: undefined')
if (noTakeover && isolated === instrumented) console.log('BENCH_NO_TAKEOVER=1 had no effect: the preview hook was renamed')
else if (noTakeover) console.log('BENCH_NO_TAKEOVER=1: takeover preview disabled for this run')
await writeFile(backgroundPath, noTakeover ? isolated : instrumented)
await writeFile(join(extension, 'config.js'), `export const HUB_URL = ${JSON.stringify(hub.url)}\n`)
const manifestPath = join(extension, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [`${hub.url}/*`, 'http://127.0.0.1/*']
await writeFile(manifestPath, JSON.stringify(manifest))

const context = await chromium.launchPersistentContext('', {
  headless: true, channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const stats = (worker) => worker.evaluate(() => globalThis.__cdpStats)
const tabsQueried = (worker) => worker.evaluate(() => globalThis.__tabsStats.query)
const reset = (worker) => worker.evaluate(() => { globalThis.__cdpStats.total = 0; globalThis.__cdpStats.byMethod = {}; globalThis.__tabsStats.query = 0 })
const rows = []
async function measure(worker, label, iterations, fn) {
  await fn() // warm up caches outside the measurement
  await reset(worker)
  const samples = []
  for (let i = 0; i < iterations; i++) { const start = performance.now(); await fn(); samples.push(performance.now() - start) }
  const counted = await stats(worker), queried = await tabsQueried(worker)
  rows.push({ label, medianMs: median(samples).toFixed(1), minMs: Math.min(...samples).toFixed(1), cdpCalls: counted.total, methods: `tabsQuery=${queried} ` + Object.entries(counted.byMethod).map(([k, v]) => `${k.replace(/^[A-Za-z]+\./, '')}=${v}`).join(' ') })
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(pageUrl)
  await page.bringToFront()
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.locator('#remoteToggle').check()
  const started = Date.now()
  while (!/已连接/.test(await popup.locator('#remoteStatus').textContent())) {
    if (Date.now() - started > 10000) throw new Error('extension did not connect')
    await new Promise((r) => setTimeout(r, 50))
  }
  const secret = (await popup.locator('#remoteDeviceId').inputValue()).slice(3)
  const browser = createBrowser({ driverId: secret }, { hubUrl: hub.url })
  await browser.tabs()
  await page.bringToFront()
  const tabs = (await browser.tabs()).tabs
  const tab = tabs.find((item) => item.url === pageUrl)
  const tabId = tab.id
  console.log('page visibility:', await page.evaluate(() => document.visibilityState), 'tab attached:', tab.attached)
  {
    const other = await context.newPage()
    await other.goto('about:blank')
    await other.bringToFront()
    console.log('fixture visibility while another tab is focused:', await page.evaluate(() => document.visibilityState), 'hasFocus:', await page.evaluate(() => document.hasFocus()))
    await other.close()
    await page.bringToFront()
  }

  await measure(worker, 'GET /api/tabs', 8, () => browser.tabs())
  await measure(worker, 'POST /api/evaluate (1+1)', 8, () => browser.request('POST', '/api/evaluate', { tabId, expression: '1+1' }))
  await measure(worker, 'POST /api/actions click observe=none', 8, () => browser.request('POST', '/api/actions', { tabId, actions: [{ type: 'click', target: '#apply' }], observe: 'none' }))
  await measure(worker, 'POST /api/actions fill+click observe=none', 6, () => browser.request('POST', '/api/actions', { tabId, actions: [{ type: 'fill', target: '#message', text: 'x' }, { type: 'click', target: '#apply' }], observe: 'none' }))
  await measure(worker, 'GET /api/observe', 5, () => browser.request('GET', `/api/observe?tabId=${tabId}`))
  await measure(worker, 'GET /api/read', 5, () => browser.request('GET', `/api/read?tabId=${tabId}`))
  await measure(worker, 'GET /api/screenshot', 5, () => browser.request('GET', `/api/screenshot?tabId=${tabId}`))

  const large = await browser.request('POST', '/api/tabs/create', { url: `${pageUrl}large` })
  const largeReady = await browser.request('GET', `/api/observe?tabId=${large.tabId}&maxLength=100`)
  console.log('large page observation:', JSON.stringify({ frames: largeReady.frames?.length, characters: largeReady.totalCharacters, nodes: undefined }))
  await measure(worker, 'GET /api/observe (1500 rows)', 5, () => browser.request('GET', `/api/observe?tabId=${large.tabId}&maxLength=4000`))
  await measure(worker, 'POST /api/actions click observe=none (large)', 5, () => browser.request('POST', '/api/actions', { tabId: large.tabId, actions: [{ type: 'click', target: '#apply' }], observe: 'none' }))
  await measure(worker, 'POST /api/actions click observe=snapshot (large)', 5, () => browser.request('POST', '/api/actions', { tabId: large.tabId, actions: [{ type: 'click', target: '#apply' }] }))

  // Overlay lifetime probe: how long after a click does the hint stay queryable?
  await browser.request('POST', '/api/actions', { tabId, actions: [{ type: 'click', target: '#apply' }], observe: 'none' })
  const seen = []
  const probeStart = Date.now()
  for (;;) {
    const present = await page.evaluate(() => !!document.querySelector('[data-bro-relay-action-overlay]'))
    seen.push(`${Date.now() - probeStart}ms:${present ? 1 : 0}`)
    if (!present) break
    if (Date.now() - probeStart > 4000) break
    await new Promise((r) => setTimeout(r, 50))
  }
  console.log('overlay presence after click (probe latency ~5ms/step):', seen.join(' '))

  // Cold first action on a brand-new tab.
  const created = await browser.request('POST', '/api/tabs/create', { url: pageUrl })
  await reset(worker)
  const coldStart = performance.now()
  await browser.request('POST', '/api/actions', { tabId: created.tabId, actions: [{ type: 'click', target: '#apply' }], observe: 'none' })
  const coldMs = performance.now() - coldStart
  const coldStats = await stats(worker)
  console.log('cold first click on fresh tab:', coldMs.toFixed(0) + 'ms', coldStats.total, 'cdp calls:', JSON.stringify(coldStats.byMethod))

  // Subframe targeting probe: no fixture covered the frame-offset path.
  let iframeProbe = 'FAIL: frame not observed'
  try {
    const hosted = await browser.request('POST', '/api/tabs/create', { url: `${pageUrl}frame` })
    const observed = await browser.request('GET', `/api/observe?tabId=${hosted.tabId}`)
    const inner = (observed.frames || []).find((frame) => frame.parentId && frame.url.includes('inner=1'))
    if (inner) {
      await browser.request('POST', '/api/actions', {
        tabId: hosted.tabId,
        actions: [{ type: 'click', target: { selector: '#apply', frameId: inner.id } }],
        observe: 'none',
      })
      const read = await browser.request('POST', '/api/evaluate', {
        tabId: hosted.tabId,
        expression: "document.querySelector('iframe').contentDocument.getElementById('result').textContent",
      })
      iframeProbe = read.value === 'Applied: hello' ? 'PASS' : `FAIL: result=${JSON.stringify(read.value)}`
    }
    await browser.request('POST', '/api/tabs/close', { tabId: hosted.tabId })
  } catch (error) { iframeProbe = `FAIL: ${error.message}` }
  console.log('subframe click probe:', iframeProbe)

  // CLI end-to-end, including node startup and the tabs pre-flight.
  const cliRoot = await mkdtemp(join(tmpdir(), 'bro-relay-bench-cli-'))
  await cp(join(root, 'cli'), join(cliRoot, 'cli'), { recursive: true })
  await writeFile(join(cliRoot, 'config.js'), `export const HUB_URL = ${JSON.stringify(hub.url)}\n`)
  await writeFile(join(cliRoot, 'package.json'), '{"type":"module"}\n')
  await mkdir(join(cliRoot, 'extension'), { recursive: true })
  await cp(join(root, 'extension', 'protocol.js'), join(cliRoot, 'extension', 'protocol.js'))
  const cliEnv = { ...process.env, BRO_RELAY_STATE_DIR: join(cliRoot, 'state') }
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cliRoot, 'cli/index.js'), ...args], { cwd: cliRoot, env: cliEnv })
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.on('close', (code) => resolve({ code, stdout })); child.on('error', reject)
  })
  await cli(['connect', 'br-' + secret])
  await cli(['eval', '1+1', '--tab', tabId])
  await reset(worker)
  const cliSamples = []
  for (let i = 0; i < 5; i++) { const start = performance.now(); await cli(['eval', '1+1', '--tab', tabId]); cliSamples.push(performance.now() - start) }
  const cliCounted = await stats(worker), cliQueried = await tabsQueried(worker)
  rows.push({ label: 'CLI eval --tab', medianMs: median(cliSamples).toFixed(1), minMs: Math.min(...cliSamples).toFixed(1), cdpCalls: (cliCounted.total / 5).toFixed(2), methods: `tabsQuery=${(cliQueried / 5).toFixed(2)} per command` })

  // The automatic snapshot is what makes a one-shot action slow on a real page.
  const cliTimed = async (args, runs) => {
    const samples = []
    for (let i = 0; i < runs; i++) { const start = performance.now(); await cli(args); samples.push(performance.now() - start) }
    return median(samples)
  }
  rows.push({ label: 'CLI click (large page, auto snapshot)', medianMs: (await cliTimed(['click', '#apply', '--tab', large.tabId], 3)).toFixed(1), minMs: '-', cdpCalls: '-', methods: '' })
  rows.push({ label: 'CLI click --no-observe (large page)', medianMs: (await cliTimed(['click', '#apply', '--tab', large.tabId, '--no-observe'], 3)).toFixed(1), minMs: '-', cdpCalls: '-', methods: '' })
  await browser.request('POST', '/api/tabs/close', { tabId: large.tabId })

  console.log('\n' + ['label'.padEnd(36), 'median'.padStart(8), 'min'.padStart(8), 'cdp'.padStart(6), 'methods'].join(' '))
  for (const row of rows) console.log([row.label.padEnd(36), row.medianMs.padStart(8), row.minMs.padStart(8), String(row.cdpCalls).padStart(6), row.methods].join(' '))
} finally {
  await context.close(); await new Promise((resolve) => pageServer.close(resolve)); await hub.close(); await rm(extension, { recursive: true, force: true })
}
