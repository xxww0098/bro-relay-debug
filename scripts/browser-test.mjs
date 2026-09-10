import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createBrowser } from '../cli/sdk.js'
import { createMockHub } from '../tests/fixtures/mock-hub.mjs'
import { OVERLAY_LIFETIME_MS } from '../extension/action-overlay.js'
import { build } from './build.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const built = await build(root)
const artifacts = join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const fixture = join(root, 'tests/fixtures/remote-page.html')
const waitFor = async (check, timeout = 10000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for browser state')
}
const run = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], options)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject)
  child.on('close', code => resolve({ code, stdout, stderr }))
})
const hub = await createMockHub()
const pageServer = createServer(async (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(fixture)) })
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`
const extension = await mkdtemp(join(tmpdir(), 'bro-relay-extension-'))
await cp(built.extension, extension, { recursive: true })
await writeFile(join(extension, 'config.js'), `export const HUB_URL = ${JSON.stringify(hub.url)}\n`)
const manifestPath = join(extension, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [`${hub.url}/*`, 'http://127.0.0.1/*']
await writeFile(manifestPath, JSON.stringify(manifest))

const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(pageUrl)
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.setViewportSize({ width: 352, height: 420 })
  assert.equal(await popup.locator('#remoteState').textContent(), '关闭')
  assert.equal(await popup.getByRole('switch').count(), 1)
  assert.equal(await popup.locator('#regenerateDevice').isVisible(), false)
  await popup.screenshot({ path: join(artifacts, 'popup-disabled.png') })

  await popup.locator('#remoteToggle').check()
  try { await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()), 10000) }
  catch (error) { throw new Error(`${error.message}; state=${await popup.locator('#remoteState').textContent()}; status=${await popup.locator('#remoteStatus').textContent()}`) }
  const firstId = await popup.locator('#remoteDeviceId').inputValue()
  assert.match(firstId, /^br-[A-Za-z0-9_-]{16,}$/)
  // Both surfaces must copy through the visible control, including keyboard use.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  for (const surface of ['popup.html', 'options.html']) {
    await popup.goto(`chrome-extension://${extensionId}/${surface}`)
    await waitFor(async () => (await popup.locator('#remoteDeviceId').inputValue()) === firstId)
    assert.equal(await popup.getByRole('button', { name: '停止并接管' }).count(), 0)
    await popup.getByRole('button', { name: '复制' }).click()
    assert.equal(await popup.evaluate(() => navigator.clipboard.readText()), firstId)
    await popup.evaluate(() => navigator.clipboard.writeText(''))
    await popup.getByRole('button', { name: '复制' }).focus()
    await popup.keyboard.press('Enter')
    await waitFor(async () => (await popup.evaluate(() => navigator.clipboard.readText())) === firstId)
    await popup.evaluate(() => navigator.clipboard.writeText(''))
    await popup.locator('#remoteDeviceId').click()
    await waitFor(async () => (await popup.evaluate(() => navigator.clipboard.readText())) === firstId)
  }
  await popup.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Denied') } })
  await popup.getByRole('button', { name: '复制' }).click()
  await waitFor(async () => /自动复制失败/.test(await popup.locator('#remoteStatus').textContent()))
  assert.equal(await popup.locator('#remoteDeviceId').evaluate(el => el.selectionEnd - el.selectionStart), firstId.length)
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await waitFor(async () => (await popup.locator('#remoteDeviceId').inputValue()) === firstId)
  const firstSecret = firstId.slice(3)
  await popup.evaluate(() => { document.querySelector('#remoteDeviceId').value = '[REDACTED]' })
  await popup.screenshot({ path: join(artifacts, 'popup.png'), animations: 'disabled' })
  const browser = createBrowser({ driverId: firstSecret }, { hubUrl: hub.url })
  const tabs = await browser.tabs()
  const tab = tabs.tabs.find((item) => item.url === pageUrl)
  assert.ok(tab, 'fixture tab is listed')
  const read = await browser.request('GET', `/api/read?tabId=${encodeURIComponent(tab.id)}`)
  assert.match(JSON.stringify(read), /Remote fixture/)
  const evaluated = await browser.request('POST', '/api/evaluate', { tabId: tab.id, expression: 'document.title' })
  assert.equal(evaluated.value, 'Bro Relay fixture')
  const actions = await browser.request('POST', '/api/actions', { tabId: tab.id, actions: [{ type: 'fill', target: { selector: '#message' }, text: 'worked' }, { type: 'click', target: { selector: '#apply' } }], observe: 'none' })
  assert.equal(actions.ok, true)
  assert.equal(await page.locator('#result').textContent(), 'Applied: worked')
  await browser.request('GET', `/api/network?tabId=${tab.id}`)
  await page.evaluate(async () => { await fetch('/redaction-check', { headers: { Authorization: 'Bearer test-private-token', 'X-Api-Key': 'test-private-api-key' } }) })
  const network = await browser.request('GET', `/api/network?tabId=${tab.id}`)
  assert.ok(JSON.stringify(network).includes('[redacted]'))
  assert.equal(JSON.stringify(network).includes('test-private-token'), false)
  assert.equal(JSON.stringify(network).includes('test-private-api-key'), false)
  const screenshot = await browser.request('GET', `/api/screenshot?tabId=${encodeURIComponent(tab.id)}`)
  assert.equal(screenshot.format, 'png'); assert.ok(screenshot.bytes > 100)
  await writeFile(join(artifacts, 'browser-test.png'), Buffer.from(screenshot.data, 'base64'))

  await popup.locator('#remoteToggle').uncheck()
  await assert.rejects(() => browser.tabs(), /Connection lost|offline|unknown|failed|409/i)
  await popup.locator('#remoteToggle').check()
  await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()))
  assert.equal(await popup.locator('#remoteDeviceId').inputValue(), firstId)
  await popup.locator('#regenerateDevice').click()
  await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()))
  const secondId = await popup.locator('#remoteDeviceId').inputValue()
  assert.notEqual(secondId, firstId)
  await assert.rejects(() => browser.tabs(), /Connection lost|offline|unknown|failed|409/i)
  const secondSecret = secondId.slice(3)
  const second = createBrowser({ driverId: secondSecret }, { hubUrl: hub.url })
  assert.ok((await second.tabs()).tabs.some((item) => item.url === pageUrl))
  const cliRoot = await mkdtemp(join(tmpdir(), 'bro-relay-cli-'))
  await cp(join(root, 'cli'), join(cliRoot, 'cli'), { recursive: true })
  await writeFile(join(cliRoot, 'config.js'), `export const HUB_URL = ${JSON.stringify(hub.url)}\n`)
  await writeFile(join(cliRoot, 'package.json'), '{"type":"module"}\n')
  // The copied SDK imports ../extension/protocol.js; provide that exact path.
  await mkdir(join(cliRoot, 'extension'))
  await cp(join(root, 'extension', 'protocol.js'), join(cliRoot, 'extension', 'protocol.js'))
  const cliEnv = { ...process.env, BRO_RELAY_STATE_DIR: join(cliRoot, 'state') }
  const connected = await run(join(cliRoot, 'cli/index.js'), ['connect', secondId], { cwd: cliRoot, env: cliEnv })
  assert.equal(connected.code, 0, connected.stderr)
  const cliTabs = await run(join(cliRoot, 'cli/index.js'), ['tabs'], { cwd: cliRoot, env: cliEnv })
  assert.equal(cliTabs.code, 0, JSON.stringify(cliTabs))
  assert.equal(JSON.parse(connected.stdout).connected, true)
  assert.ok(JSON.parse(cliTabs.stdout).tabs.some(item => item.id === tab.id))
  for (const [args, check] of [
    [['find', 'Apply', '--tab', tab.id], result => result.matches.some(item => item.name === 'Apply')],
    [['extract', '#result', '--tab', tab.id], result => result.value.items[0].text === 'Applied: worked'],
    [['wait', '#apply', '--tab', tab.id], result => result.task.status === 'completed'],
  ]) {
    const result = await run(join(cliRoot, 'cli/index.js'), args, { cwd: cliRoot, env: cliEnv })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(check(JSON.parse(result.stdout)))
  }
  const cliResult = async (args) => run(join(cliRoot, 'cli/index.js'), args, { cwd: cliRoot, env: cliEnv })
  const scrolled = await cliResult(['scroll', '700', '--tab', tab.id])
  assert.equal(scrolled.code, 0, scrolled.stderr)
  const scrollState = await cliResult(['eval', 'window.scrollY', '--tab', tab.id])
  assert.equal(scrollState.code, 0, scrollState.stderr)
  assert.ok(JSON.parse(scrollState.stdout).value > 0, `expected page scroll, got ${scrollState.stdout}`)

  const startMoving = await cliResult(['eval', 'startMoving()', '--tab', tab.id])
  assert.equal(startMoving.code, 0, startMoving.stderr)
  const moving = await cliResult(['click', '#moving', '--tab', tab.id])
  assert.equal(moving.code, 0, moving.stderr)
  // Read the hint in-process: a fresh node process per read races its lifetime.
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('#moving').getBoundingClientRect()
    const target = document.querySelector('[data-bro-relay-action-overlay]')?.__broRelayRoot?.querySelector('.target')
    return target && { button: { x: button.x, y: button.y, width: button.width, height: button.height },
      overlay: { x: Number.parseFloat(target.style.left), y: Number.parseFloat(target.style.top), width: Number.parseFloat(target.style.width), height: Number.parseFloat(target.style.height) } }
  })
  assert.ok(geometry, 'action overlay should be visible right after the click')
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(geometry.button[key] - geometry.overlay[key]) < 1, `${key}: ${JSON.stringify(geometry)}`)
  assert.equal(JSON.parse((await cliResult(['eval', "document.getElementById('moving-count').textContent", '--tab', tab.id])).stdout).value, '1')
  assert.equal(JSON.parse((await cliResult(['eval', 'movingClickedWhileActive', '--tab', tab.id])).stdout).value, false)
  await second.request('POST', '/api/actions', { tabId: tab.id, actions: [{ type: 'click', target: '#moving' }] })
  const actionLabel = await page.evaluate(() => {
    const root = document.querySelector('[data-bro-relay-action-overlay]').__broRelayRoot
    const label = root.querySelector('.label'), box = label.getBoundingClientRect()
    const target = document.querySelector('#moving').getBoundingClientRect()
    return { text: label.textContent, inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      outsideTarget: box.bottom <= target.top || box.top >= target.bottom }
  })
  assert.equal(actionLabel.text, '点击')
  assert.equal(actionLabel.inside, true, 'action label must stay in viewport')
  assert.equal(actionLabel.outsideTarget, true, 'action label must not cover the target')
  const freezeRipple = async time => page.evaluate(time => {
    const ripple = document.querySelector('[data-bro-relay-action-overlay]').__broRelayRoot.querySelector('.ripple')
    const animation = ripple.getAnimations()[0]
    animation.pause(); animation.currentTime = time
    return getComputedStyle(ripple).transform
  }, time)
  const earlyRipple = await freezeRipple(40)
  await page.screenshot({ path: join(artifacts, 'action-overlay.png') })
  const movingBox = await page.locator('#moving').boundingBox()
  assert.ok(movingBox)
  await page.screenshot({ path: join(artifacts, 'action-overlay-target.png'), clip: {
    x: Math.max(0, movingBox.x - 24), y: Math.max(0, movingBox.y - 64),
    width: movingBox.width + 160, height: Math.min(movingBox.height + 88, 720 - Math.max(0, movingBox.y - 64)),
  } })
  const lateRipple = await freezeRipple(220)
  assert.notEqual(earlyRipple, lateRipple, 'click ripple must expand over time')
  const rippleFits = await page.evaluate(() => {
    const ripple = document.querySelector('[data-bro-relay-action-overlay]').__broRelayRoot.querySelector('.ripple')
    const radius = Number.parseFloat(ripple.style.width) * 3 / 2
    const x = Number.parseFloat(ripple.style.left), y = Number.parseFloat(ripple.style.top)
    return x - radius >= 0 && y - radius >= 0 && x + radius <= innerWidth && y + radius <= innerHeight
  })
  assert.equal(rippleFits, true, 'edge click ripple must stay inside viewport')
  await page.screenshot({ path: join(artifacts, 'action-overlay-late.png') })

  // The hint must survive long enough for a person to notice it, and must still
  // clean itself up. Measure one fresh click instead of racing the previous one.
  await second.request('POST', '/api/actions', { tabId: tab.id, actions: [{ type: 'click', target: '#apply' }], observe: 'none' })
  const overlayShownAt = Date.now()
  let overlayLifetime = null
  while (Date.now() - overlayShownAt < OVERLAY_LIFETIME_MS.max + 3000) {
    if (!(await page.evaluate(() => !!document.querySelector('[data-bro-relay-action-overlay]')))) { overlayLifetime = Date.now() - overlayShownAt; break }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.notEqual(overlayLifetime, null, 'action overlay must be removed after its idle timeout')
  assert.ok(overlayLifetime > 500, `action overlay must stay visible long enough to be seen, saw ${overlayLifetime}ms`)

  // A screenshot is evidence: the hint must never be baked into the pixels.
  await second.request('POST', '/api/actions', { tabId: tab.id, actions: [{ type: 'click', target: '#apply' }], observe: 'none' })
  await second.request('GET', `/api/screenshot?tabId=${encodeURIComponent(tab.id)}`)
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-bro-relay-action-overlay]')), false, 'a screenshot must dismiss the action hint')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await second.request('POST', '/api/actions', { tabId: tab.id, actions: [{ type: 'hover', target: '#moving' }] })
  const reducedMotion = await page.evaluate(() => {
    const host = document.querySelector('[data-bro-relay-action-overlay]')
    const button = document.querySelector('#moving'), rect = button.getBoundingClientRect()
    return { transition: getComputedStyle(host.__broRelayRoot.querySelector('.cursor')).transitionDuration,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button }
  })
  assert.equal(reducedMotion.transition, '0s')
  assert.equal(reducedMotion.hit, true, 'overlay must not intercept the actual target')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await page.evaluate(() => { blocker.hidden = false })
  const blocked = await cliResult(['click', '#blocked', '--tab', tab.id, '--timeout', '200'])
  assert.notEqual(blocked.code, 0, 'obscured target should time out')
  assert.equal(JSON.parse((await cliResult(['eval', "document.getElementById('blocked-count').textContent", '--tab', tab.id])).stdout).value, '0')
  await page.evaluate(() => { blocker.hidden = true })

  // Scrolling an inner container is movement even when the page text and the page
  // scroll offset stay put; it must not be reported as "no change".
  const feeder = await second.request('POST', '/api/actions', { tabId: tab.id, observe: 'none',
    actions: [{ type: 'scroll', target: { selector: '#feeder' }, deltaY: 120, waitForChange: true, timeoutMs: 150 }] })
  assert.equal(feeder.ok, true, JSON.stringify(feeder))
  assert.equal(feeder.task.results[0].elementScrolled, true, 'inner scroll must be reported as movement')
  assert.equal(feeder.task.results[0].warning, undefined, 'inner scroll must not warn about missing change')

  // A control that replaces its own node on activation must still verify.
  const rebind = await second.request('POST', '/api/actions', { tabId: tab.id, observe: 'none',
    actions: [{ type: 'check', target: { selector: '#rebind' }, checked: true }] })
  assert.equal(rebind.ok, true, JSON.stringify(rebind))
  assert.equal(rebind.task.results[0].checked, true)
  assert.equal(await page.evaluate(() => document.getElementById('rebind').checked), true, 're-rendered control must stay checked')

  const partialCoordinateFile = join(cliRoot, 'partial-coordinate.json')
  await writeFile(partialCoordinateFile, JSON.stringify({ actions: [{ type: 'scroll', x: 10, deltaY: 100 }] }))
  const partialCoordinate = await cliResult(['actions', '--file', partialCoordinateFile, '--tab', tab.id])
  assert.notEqual(partialCoordinate.code, 0, 'scroll with only one coordinate should fail')
  assert.match(partialCoordinate.stderr, /invalid_coordinates|x and y/i)
  // The agent operates the current tab in place: no preview tab may open.
  await page.goto(pageUrl)
  await page.bringToFront()
  const nativeSource = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), pageUrl)
  await page.evaluate(() => { window.lastApplyTrusted = null; document.querySelector('#apply').addEventListener('click', event => { window.lastApplyTrusted = event.isTrusted }) })
  const inPlace = await second.request('POST', '/api/actions', { tabId: tab.id, async: true,
    actions: [{ type: 'wait', target: '#allow-agent', timeoutMs: 10000 },
      { type: 'fill', target: '#message', text: 'in-place work' }, { type: 'key', key: 'Backspace' },
      { type: 'type', text: 'k verified' }, { type: 'click', target: '#apply' },
      { type: 'wait', target: '#finish-agent', timeoutMs: 10000 }], observe: 'none' })
  await page.evaluate(() => { const marker = document.createElement('div'); marker.id = 'allow-agent'; marker.textContent = 'ready'; document.body.prepend(marker) })
  await waitFor(async () => (await page.locator('#result').textContent()) === 'Applied: in-place work verified')
  assert.equal(await page.evaluate(() => window.lastApplyTrusted), true, 'in-place clicks must retain native event semantics')
  await page.evaluate(() => { const marker = document.createElement('div'); marker.id = 'finish-agent'; marker.textContent = 'done'; document.body.prepend(marker) })
  await waitFor(async () => (await second.request('GET', `/api/tasks/${inPlace.task.id}`)).task.status === 'completed')
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), nativeSource.id)).active, true, 'agent work must stay in the current tab')
  assert.ok(!context.pages().some(p => p.url().startsWith(`chrome-extension://${extensionId}/preview.html`)), 'no preview tab may open')

  const pending = await second.request('POST', '/api/actions', { tabId: tab.id, async: true,
    actions: [{ type: 'wait', target: '#never-created', timeoutMs: 10000 }, { type: 'click', target: '#apply' }], observe: 'none' })
  await waitFor(async () => (await second.request('GET', `/api/tasks/${pending.task.id}`)).task.status === 'running')
  const queued = await second.request('POST', '/api/actions', { tabId: tab.id, async: true,
    actions: [{ type: 'click', target: '#apply' }], observe: 'none' })
  await page.locator('#message').fill('must-not-apply-after-stop')
  const beforeStop = await page.locator('#result').textContent()
  await popup.setViewportSize({ width: 352, height: 600 })
  await popup.locator('#remoteToggle').uncheck()
  await waitFor(async () => (await popup.locator('#remoteState').textContent()) === '关闭')
  assert.equal(await popup.locator('#remoteDeviceId').inputValue(), secondId, 'stopping must retain the driver ID')
  assert.equal(await page.locator('#result').textContent(), beforeStop, 'cancelled clicks must not run')
  await popup.locator('#remoteToggle').check()
  await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()))
  for (const job of [pending, queued]) {
    const result = await second.request('GET', `/api/tasks/${job.task.id}`)
    assert.equal(result.task.status, 'cancelled', `stop must cancel running and queued work: ${JSON.stringify(result.task)}`)
  }
  const disconnectedTask = await second.request('POST', '/api/actions', { tabId: tab.id, async: true,
    actions: [{ type: 'wait', target: '#never-created', timeoutMs: 10000 }], observe: 'none' })
  hub.disconnect()
  await waitFor(async () => {
    try { return (await second.request('GET', `/api/tasks/${disconnectedTask.task.id}`)).task.status === 'cancelled' }
    catch { return false }
  })
  await waitFor(async () => /已连接/.test(await popup.locator('#remoteState').textContent()))
  await rm(cliRoot, { recursive: true, force: true })
  console.log(`browser e2e passed; screenshots: ${artifacts}`)
} finally {
  await context.close(); await new Promise((resolve) => pageServer.close(resolve)); await hub.close(); await rm(extension, { recursive: true, force: true })
}
