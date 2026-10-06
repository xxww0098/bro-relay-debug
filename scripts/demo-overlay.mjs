// Real-chain demo: builds the extension, loads it into a visible Chromium,
// connects through a local mock hub, then drives a paced action sequence so the
// on-page agent animation is recorded to artifacts/demo-video/*.webm.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { createBrowser } from '../cli/sdk.js'
import { createMockHub } from '../tests/fixtures/mock-hub.mjs'
import { build } from './build.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const built = await build(root)
const artifacts = join(root, 'artifacts')
const videoDir = join(artifacts, 'demo-video')
await mkdir(artifacts, { recursive: true })
await rm(videoDir, { recursive: true, force: true })

const feedItems = Array.from({ length: 30 }, (_, i) => `<div>feed item ${i + 1}</div>`).join('')
const demoHtml = `<!doctype html><meta charset="utf-8"><title>Agent demo</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1f2937}
  .card{border:1px solid #e2e2ea;border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 3px #0001}
  input,select,button{font:inherit;padding:6px 10px;border:1px solid #c9c9d4;border-radius:6px;background:#fff}
  button{background:#4f46e5;color:#fff;border:0;cursor:pointer}
  #feed{height:140px;overflow:auto;border:1px solid #e2e2ea;border-radius:8px;padding:8px;margin-top:8px}
  .todo{display:flex;gap:8px;align-items:center;padding:4px 0}
  #status{color:#16a34a;min-height:20px;margin-left:8px}
</style>
<h2>Bro Relay — agent 操作演示</h2>
<div class="card">
  <input id="new-todo" placeholder="新任务" style="width:220px">
  <select id="priority"><option value="low">低优先级</option><option value="high">高优先级</option></select>
  <button id="add">添加</button><span id="status"></span>
</div>
<div class="card" id="list">
  <div class="todo"><input type="checkbox" id="t1"><label for="t1">写文档</label></div>
  <div class="todo"><input type="checkbox" id="t2"><label for="t2">回邮件</label></div>
  <div class="todo"><input type="checkbox" id="t3"><label for="t3">代码评审</label></div>
</div>
<div class="card"><b>动态 feed</b><div id="feed">${feedItems}</div></div>
<script>
  const add = () => {
    const row = document.createElement('div'); row.className = 'todo'
    row.innerHTML = '<input type="checkbox"><label></label>'
    row.querySelector('label').textContent = document.getElementById('new-todo').value || '未命名任务'
    document.getElementById('list').append(row)
    setTimeout(() => { document.getElementById('status').textContent = '已保存' }, 1200)
  }
  document.getElementById('add').onclick = add
  document.getElementById('new-todo').addEventListener('keydown', e => { if (e.key === 'Enter') add() })
</script>`

const hub = await createMockHub()
const pageServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(demoHtml) })
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`
const extension = await mkdtemp(join(tmpdir(), 'bro-relay-ext-'))
await cp(built.extension, extension, { recursive: true })
await writeFile(join(extension, 'config.js'), `export const HUB_URL = ${JSON.stringify(hub.url)}\n`)
const manifestPath = join(extension, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [`${hub.url}/*`, 'http://127.0.0.1/*']
await writeFile(manifestPath, JSON.stringify(manifest))

const context = await chromium.launchPersistentContext('', {
  headless: false,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1320,920', '--window-position=60,60'],
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check, timeout = 10000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100) }
  throw new Error('Timed out waiting for browser state')
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(pageUrl)
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.locator('#remoteToggle').check()
  await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()))
  const driverId = await popup.locator('#remoteDeviceId').inputValue()
  console.log('extension connected, driver id:', driverId.slice(0, 14) + '…')
  await popup.close()

  const browser = createBrowser({ driverId }, { hubUrl: hub.url })
  const tab = (await browser.tabs()).tabs.find((item) => item.url === pageUrl)
  const act = (actions) => browser.request('POST', '/api/actions', { tabId: tab.id, actions, observe: 'none' })
  const step = async (actions, gap = 1100) => { const r = await act(actions); if (!r.ok) throw new Error(JSON.stringify(r)); await sleep(gap) }

  await step([{ type: 'click', target: { selector: '#new-todo' } }])
  await step([{ type: 'fill', target: { selector: '#new-todo' }, text: '给用户演示动画' }])
  await step([{ type: 'key', key: 'Enter' }], 1600)
  await step([{ type: 'select', target: { selector: '#priority' }, value: 'high' }])
  await step([{ type: 'check', target: { selector: '#t1' }, checked: true }])
  await step([{ type: 'check', target: { selector: '#t2' }, checked: true }])
  await step([{ type: 'scroll', target: { selector: '#feed' }, deltaY: 300 }])
  await step([{ type: 'hover', target: { selector: '#add' } }], 1400)
  await step([{ type: 'click', target: { selector: '#add' } }], 1600)
  await step([{ type: 'wait', target: { selector: '#status' }, state: 'visible', timeoutMs: 5000 }])
  await browser.request('POST', '/api/release', { tabId: tab.id })
  console.log('actions done; state:', await page.locator('#status').textContent(), '| todos:', await page.locator('.todo').count())
  await sleep(800)
} finally {
  await context.close()
  await hub.close()
  pageServer.close()
}
console.log('video dir:', videoDir)
