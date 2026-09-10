const POLL_INTERVAL = 1000;
const HIDDEN_POLL_INTERVAL = 5000;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

const title = document.querySelector("#previewTitle");
const image = document.querySelector("#previewImage");
const emptyState = document.querySelector("#emptyState");
const capturedAt = document.querySelector("#capturedAt");
const status = document.querySelector("#updateStatus");
const stopButton = document.querySelector("#stopTakeover");

let timer = null;
let requestInFlight = false;
let stopped = false;

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

function schedulePoll() {
  if (stopped || timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    poll();
  }, document.hidden ? HIDDEN_POLL_INTERVAL : POLL_INTERVAL);
}

function showInactive() {
  stopped = true;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  image.hidden = true;
  emptyState.hidden = false;
  emptyState.textContent = "正在返回原页…";
  capturedAt.hidden = true;
  setStatus("代理已停止，正在返回原页。", "inactive");
}

function renderPreview(response) {
  if (!response || response.active !== true) {
    showInactive();
    return;
  }

  stopped = false;
  if (typeof response.title === "string") title.textContent = response.title || "未命名页面";
  if (typeof response.image === "string" && JPEG_DATA_URL.test(response.image)) {
    image.src = response.image;
    image.hidden = false;
    emptyState.hidden = true;
  }
  if (Number.isFinite(response.capturedAt)) {
    capturedAt.hidden = false;
    capturedAt.dateTime = new Date(response.capturedAt).toISOString();
    capturedAt.textContent = new Date(response.capturedAt).toLocaleTimeString();
  }
  if (typeof response.error === "string" && response.error) {
    setStatus("画面未更新：远程画面暂时不可用。", "error");
  } else {
    setStatus("代理在后台执行，画面已更新。", "");
  }
}

async function poll() {
  if (stopped || requestInFlight) return;
  requestInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "getTakeoverPreview" });
    renderPreview(response);
  } catch {
    setStatus("画面未更新：暂时无法连接后台代理。", "error");
  } finally {
    requestInFlight = false;
    if (!stopped) schedulePoll();
  }
}

stopButton.addEventListener("click", async () => {
  if (stopped) return;
  stopButton.disabled = true;
  stopped = true;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  setStatus("正在停止代理并返回原页…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "stopTakeover" });
    if (result?.error) throw new Error(result.error);
  } catch {
    stopButton.disabled = false;
    stopped = false;
    setStatus("停止失败：请重试。", "error");
    schedulePoll();
  }
});

document.addEventListener("visibilitychange", () => {
  if (stopped) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  schedulePoll();
});

poll();
