// MV3 service workers freeze idle timers. This document ticks so the worker
// wakes, heartbeats the hub, and can answer a ping instead of hanging the CLI.
setInterval(() => { chrome.runtime.sendMessage({ type: 'bro-keepalive' }).catch(() => {}); }, 15000);
chrome.runtime.sendMessage({ type: 'bro-keepalive' }).catch(() => {});
