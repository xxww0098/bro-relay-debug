#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowser, handshake, parseDriverId, RelayError } from './sdk.js';

const directory = process.env.BRO_RELAY_STATE_DIR || path.join(os.homedir(), '.bro-relay-debug');
const connectionFile = path.join(directory, 'connection.json');
let activeSecret;
const usage = `bro-relay-debug <command> [--tab ID]

connect <driver-id> | connect --stdin  Verify and save a connection
status | doctor                      Check saved connection and capabilities
disconnect                           Remove the local saved credential
release                              Dismiss the pointer and close the control preview
tabs                                 List controllable pages
tabs new URL | tabs close | tabs focus
state | read | observe [--diff] [--cursor CURSOR]
find TEXT                            Find matching accessible nodes (max 100)
extract SELECTOR                     Extract structured text/links (max 100)
screenshot --out FILE [--full-page]
eval EXPR | eval --file FILE          Evaluate browser JavaScript
actions --file FILE                  Action array or full actions body JSON
navigate URL | click TARGET [--timeout MS] | fill TARGET TEXT
type TEXT | key KEY | scroll AMOUNT | wait TARGET [--timeout MS]
--no-observe                         Skip the automatic page snapshot after actions
network | console                    Start capture and read captured events
task get ID | task cancel ID
raw GET|POST /api/path [--file FILE]

TARGET is an observed element ref or CSS selector. Multiple tabs require --tab.
Actions return task identity and progress. Never replay a failed write blindly.
Hub URL is fixed at build time. Driver IDs are credentials; prefer stdin.`;

function invalid(message) {
  throw new RelayError({ code: 'invalid_arguments', message, status: 400 });
}
function required(value, name) {
  if (value === undefined || value === '') invalid(`${name} is required`);
  return value;
}
function number(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) invalid(`Expected a number between ${min} and ${max}`);
  return n;
}
function output(value) {
  process.stdout.write(JSON.stringify(value ?? null) + '\n');
}
function failure(error) {
  const payload = error instanceof RelayError ? error.payload : {
    ok: false, code: error.code || 'cli_error', message: error.message || 'Command failed',
  };
  let serialized = JSON.stringify(payload);
  if (activeSecret) serialized = serialized.replaceAll(`br-${activeSecret}`, '[REDACTED]').replaceAll(activeSecret, '[REDACTED]');
  process.stderr.write(serialized + '\n');
  process.exitCode = 1;
}
async function readJson(file) {
  return JSON.parse(await fs.readFile(required(file, '--file'), 'utf8'));
}
async function connection() {
  try {
    const saved = await readJson(connectionFile);
    activeSecret = saved.driverId;
    return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new RelayError({ code: 'not_connected', message: 'Run connect with the current driver ID first', status: 401 });
  }
}
async function readDriverId() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 256) invalid('Driver ID is too long');
  }
  return text.trim();
}
async function saveConnection(parsed) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${connectionFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(parsed) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, connectionFile);
  } finally { await fs.rm(temporary, { force: true }); }
}
// Listing tabs is a full hub round trip. An explicit --tab is validated by the
// extension itself, so listing first only doubles the latency of every command.
async function selectTab(browser, requested) {
  if (requested) return { id: requested };
  const { tabs = [] } = await browser.tabs();
  if (tabs.length === 1) return tabs[0];
  throw new RelayError({ code: tabs.length ? 'tab_selection_required' : 'no_tabs',
    message: tabs.length ? 'Use --tab to select a page from tabs' : 'No controllable pages are open', status: 400 });
}

export function filterNodes(nodes, query) {
  const needle = query.toLocaleLowerCase();
  const matches = nodes.filter(node => node.ref && String(node.name || '').toLocaleLowerCase().includes(needle));
  return {
    matches: matches.slice(0, 100).map(({ ref, role, name, frameId }) => ({ ref, role, name, frameId })),
    total: matches.length, truncated: matches.length > 100,
  };
}

async function main() {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, stdin: { type: 'boolean' },
      file: { type: 'string' }, out: { type: 'string' }, tab: { type: 'string' },
      timeout: { type: 'string' }, cursor: { type: 'string' },
      'no-observe': { type: 'boolean' },
      diff: { type: 'boolean' }, 'full-page': { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || command === 'help' || flags.help) return output({ ok: true, usage });
  if (command === 'connect') {
    const parsed = parseDriverId(flags.stdin ? await readDriverId() : args[0]);
    activeSecret = parsed.driverId;
    const verified = await handshake(parsed);
    await saveConnection(parsed);
    return output({ ok: true, connected: true, protocolVersion: verified.protocolVersion, features: verified.features });
  }
  if (command === 'disconnect') {
    await fs.rm(connectionFile, { force: true });
    return output({ ok: true, disconnected: true });
  }
  const commands = ['status', 'doctor', 'tabs', 'release', 'state', 'read', 'observe', 'find', 'extract', 'screenshot', 'eval', 'actions', 'navigate', 'click', 'fill', 'type', 'key', 'scroll', 'wait', 'network', 'console', 'task', 'raw'];
  if (!commands.includes(command)) invalid(`Unknown command. Run --help.`);
  const saved = await connection();
  if (command === 'status' || command === 'doctor') {
    const verified = await handshake(saved);
    return output({ ok: true, connected: verified.connected, protocolVersion: verified.protocolVersion, features: verified.features });
  }
  const browser = createBrowser(saved);
  if (command === 'release') {
    return output(await browser.request('POST', '/api/release', { tabId: (await selectTab(browser, flags.tab)).id }));
  }
  if (command === 'tabs') {
    if (!args.length) return output(await browser.tabs());
    if (args[0] === 'new') return output(await browser.request('POST', '/api/tabs/create', { url: required(args[1], 'URL') }));
    if (!['close', 'focus'].includes(args[0])) invalid('Use tabs new, close, or focus');
    return output(await browser.request('POST', `/api/tabs/${args[0]}`, { tabId: (await selectTab(browser, flags.tab)).id }));
  }
  if (command === 'task') {
    if (!['get', 'cancel'].includes(args[0])) invalid('Use task get ID or task cancel ID');
    const id = required(args[1], 'Task ID');
    if (!/^job_[\w-]{36}$/.test(id)) invalid('Invalid task ID');
    return output(await browser.request(args[0] === 'cancel' ? 'POST' : 'GET', `/api/tasks/${id}${args[0] === 'cancel' ? '/cancel' : ''}`));
  }
  if (command === 'raw') return output(await browser.request(required(args[0], 'Method'), required(args[1], 'Path'), flags.file ? await readJson(flags.file) : undefined));
  const tab = await selectTab(browser, flags.tab);
  const tabId = tab.id;
  // Every action command snapshots the page afterwards. A caller running a known
  // sequence can skip that and observe once at the end.
  const skipObserve = flags['no-observe'] ? { observe: 'none' } : {};
  const query = new URLSearchParams({ tabId });
  if (flags.diff) query.set('diff', 'true');
  if (flags.cursor) query.set('cursor', flags.cursor);
  if (['state', 'read', 'observe'].includes(command)) {
    const observation = await browser.request('GET', `/api/${command === 'state' ? 'observe' : command}?${query}`);
    return output(command === 'state'
      ? { ok: true, tab: { ...tab, url: observation.url, title: observation.title }, observation }
      : observation);
  }
  if (command === 'find') {
    const text = required(args.join(' '), 'Search text');
    query.set('includeNodes', 'true');
    const observation = await browser.request('GET', `/api/observe?${query}`);
    return output({ ok: true, tabId, url: observation.url, ...filterNodes(observation.nodes || [], text) });
  }
  if (command === 'extract') {
    const selector = required(args[0], 'Selector');
    const expression = `(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      return { url: location.href, total: nodes.length, truncated: nodes.length > 100,
        items: Array.from(nodes).slice(0, 100).map(e => ({
          tag: e.tagName.toLowerCase(), text: (e.innerText || e.textContent || '').slice(0, 2000),
          href: e.href || undefined, label: e.getAttribute('aria-label') || undefined
        })) };
    })()`;
    return output(await browser.request('POST', '/api/evaluate', { tabId, expression }));
  }
  if (command === 'screenshot') {
    required(flags.out, '--out');
    if (flags['full-page']) query.set('fullPage', 'true');
    const result = await browser.request('GET', `/api/screenshot?${query}`);
    const bytes = Buffer.from(result.data || '', 'base64');
    if (!bytes.length) throw new Error('Extension returned an empty screenshot');
    const destination = path.resolve(flags.out);
    await fs.writeFile(destination, bytes);
    return output({ ok: true, out: destination, bytes: bytes.length });
  }
  if (command === 'eval') {
    const expression = flags.file ? await fs.readFile(flags.file, 'utf8') : required(args.join(' '), 'Expression');
    return output(await browser.request('POST', '/api/evaluate', { tabId, expression }));
  }
  if (command === 'actions') {
    const data = await readJson(flags.file);
    const body = Array.isArray(data) ? { actions: data } : data;
    return output(await browser.request('POST', '/api/actions', { ...body, tabId, ...skipObserve }));
  }
  if (command === 'network' || command === 'console') return output(await browser.request('GET', `/api/${command}?${query}`));
  let action;
  switch (command) {
    case 'navigate': action = { type: 'navigate', url: required(args[0], 'URL') }; break;
    case 'click': action = { type: 'click', target: required(args[0], 'Target'), timeoutMs: number(flags.timeout, 5000, 1, 20000) }; break;
    case 'fill':
      if (args[1] === undefined) invalid('Text is required (use an empty quoted string to clear)');
      action = { type: 'fill', target: required(args[0], 'Target'), text: args[1] }; break;
    case 'type': action = { type: 'type', text: required(args.join(' '), 'Text') }; break;
    case 'key': action = { type: 'key', key: required(args[0], 'Key') }; break;
    case 'scroll': action = { type: 'scroll', deltaY: number(args[0], 600, -100000, 100000) }; break;
    case 'wait': action = { type: 'wait', target: required(args[0], 'Target'), timeoutMs: number(flags.timeout, 5000, 1, 20000) }; break;
  }
  return output(await browser.request('POST', '/api/actions', { tabId, actions: [action], ...skipObserve }));
}

// Importable for focused CLI behavior tests without running a command.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(failure);
