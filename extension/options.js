const $ = id => document.getElementById(id);
const toggle = $('remoteToggle'), state = $('remoteState'), id = $('remoteDeviceId');
const status = $('remoteStatus'), regenerate = $('regenerateDevice');
function render(value = {}) {
  toggle.checked = !!value.enabled;
  id.value = value.deviceId || '';
  state.textContent = value.enabled ? value.connected ? '已连接' : '连接中' : '关闭';
  state.className = value.connected ? 'connected' : '';
  $('remoteDetails').hidden = !value.enabled;
  status.className = value.lastError ? 'status error' : 'status';
  status.textContent = value.enabled
    ? value.connected ? '远程中继已连接。' : value.lastError ? `连接暂不可用：${value.lastError}` : '正在连接远程中继…'
    : '启用后，将显示驱动 ID。';
}
async function update(enabled, rotate = false) {
  toggle.disabled = regenerate.disabled = true;
  try { render(await chrome.runtime.sendMessage({ type: 'setRemoteControl', enabled, rotate })); }
  catch (error) { status.textContent = error.message; status.className = 'status error'; }
  finally { toggle.disabled = regenerate.disabled = false; }
}
toggle.addEventListener('change', () => update(toggle.checked));
regenerate.addEventListener('click', () => update(true, true));
id.addEventListener('click', async () => {
  id.select();
  try { await navigator.clipboard.writeText(id.value); status.textContent = '驱动 ID 已复制。'; }
  catch { status.textContent = 'ID 已选中，可按 Ctrl/Cmd+C 复制。'; }
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'remoteStatusChanged') render(message);
});
chrome.runtime.sendMessage({ type: 'getRemoteControlStatus' }).then(render).catch(error => {
  status.textContent = error.message; status.className = 'status error';
});
