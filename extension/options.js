import { validateHub } from './hub-url.js';
const $ = id => document.getElementById(id);
$('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;
const toggle = $('remoteToggle'), state = $('remoteState'), id = $('remoteDeviceId');
const status = $('remoteStatus'), regenerate = $('regenerateDevice'), copy = $('copyDeviceId');
function render(value = {}) {
  if (document.activeElement !== $('hubUrl')) $('hubUrl').value = value.hubUrl || '';
  const d = value.diagnostic;
  $('connectionDiagnostic').textContent = d ? `最近连接：${d.outcome === 'passed' ? '成功' : d.outcome === 'pending' ? '进行中' : '失败'} · ${new Date(d.observedAt).toLocaleTimeString()}` : '';
  if (value.hubUrl) $('hubSettings').querySelector('summary').textContent = `连接地址 · ${new URL(value.hubUrl).hostname}`;
  toggle.checked = !!value.enabled;
  id.value = value.deviceId || '';
  state.textContent = value.enabled ? value.connected ? '已连接' : '连接中' : '关闭';
  state.className = value.connected ? 'connected' : '';
  $('remoteDetails').hidden = !value.enabled;
  status.className = value.lastError ? 'status error' : 'status';
  status.textContent = value.enabled
    ? value.connected ? '' : value.lastError ? `连接暂不可用：${value.lastError}` : '连接中…'
    : '开启后获取 ID。';
}
async function update(enabled, rotate = false) {
  toggle.disabled = regenerate.disabled = copy.disabled = true;
  try { render(await chrome.runtime.sendMessage({ type: 'setRemoteControl', enabled, rotate })); }
  catch (error) { status.textContent = error.message; status.className = 'status error'; }
  finally { toggle.disabled = regenerate.disabled = copy.disabled = false; }
}
toggle.addEventListener('change', () => update(toggle.checked));
regenerate.addEventListener('click', () => update(true, true));
async function copyId() {
  id.select();
  try {
    await navigator.clipboard.writeText(id.value);
    status.className = 'status';
    status.textContent = '已复制。';
  }
  catch {
    id.focus();
    id.select();
    status.className = 'status error';
    status.textContent = '自动复制失败，ID 已选中，请按 Ctrl/Cmd+C 复制。';
  }
}
copy.addEventListener('click', copyId);
id.addEventListener('click', copyId);
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'remoteStatusChanged') render(message);
});
chrome.runtime.sendMessage({ type: 'getRemoteControlStatus' }).then(render).catch(error => {
  status.textContent = error.message; status.className = 'status error';
});

function checkHub() {
  try { const origin = validateHub($('hubUrl').value); $('hubError').textContent = ''; $('hubUrl').removeAttribute('aria-invalid'); return origin; }
  catch { $('hubError').textContent = '请输入 HTTPS 域名，不包含路径或查询参数。'; $('hubUrl').setAttribute('aria-invalid', 'true'); return null; }
}
$('hubUrl').addEventListener('blur', checkHub);
$('hubForm').addEventListener('submit', async event => {
  event.preventDefault();
  const origin = checkHub();
  if (!origin) { $('hubUrl').focus(); return; }
  $('saveHub').disabled = true;
  try {
    const allowed = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!allowed) throw new Error('未授予访问权限，地址未更改。');
    const result = await chrome.runtime.sendMessage({ type: 'setRemoteControl', enabled: toggle.checked, hubUrl: origin });
    render(result);
    if (result.lastError) throw new Error(result.lastError);
    $('hubError').textContent = '';
    status.textContent = '地址已保存。';
  } catch (error) { $('hubError').textContent = error.message; }
  finally { $('saveHub').disabled = false; }
});
