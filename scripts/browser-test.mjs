import assert from 'node:assert/strict'
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
  try { await waitFor(async () => /已连接/.test(await popup.locator('#remoteStatus').textContent()), 10000) }
  catch (error) { throw new Error(`${error.message}; state=${await popup.locator('#remoteState').textContent()}; status=${await popup.locator('#remoteStatus').textContent()}`) }
  const firstId = await popup.locator('#remoteDeviceId').inputValue()
  assert.match(firstId, /^br-[A-Za-z0-9_-]{16,}$/)
  const firstSecret = firstId.slice(3)
  await popup.evaluate(() => { document.querySelector('#remoteDeviceId').value = '[REDACTED]' })
  await popup.screenshot({ path: join(artifacts, 'popup.png') })
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
  await waitFor(async () => /远程中继已连接/.test(await popup.locator('#remoteStatus').textContent()))
  assert.equal(await popup.locator('#remoteDeviceId').inputValue(), firstId)
  await popup.locator('#regenerateDevice').click()
  await waitFor(async () => /远程中继已连接/.test(await popup.locator('#remoteStatus').textContent()))
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
  await rm(cliRoot, { recursive: true, force: true })
  console.log(`browser e2e passed; screenshots: ${artifacts}`)
} finally {
  await context.close(); await new Promise((resolve) => pageServer.close(resolve)); await hub.close(); await rm(extension, { recursive: true, force: true })
}
