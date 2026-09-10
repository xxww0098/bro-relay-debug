const $ = id => document.getElementById(id);
$('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;
const toggle = $('remoteToggle'), state = $('remoteState'), id = $('remoteDeviceId');
const status = $('remoteStatus'), regenerate = $('regenerateDevice'), copy = $('copyDeviceId');
function render(value = {}) {
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
