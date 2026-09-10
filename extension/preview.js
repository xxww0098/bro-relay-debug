import { displayedImageBox, mapPointerToFrame } from './preview-pointer.js';

const POLL_INTERVAL = 100;
const HIDDEN_POLL_INTERVAL = 1000;
const POINTER_TTL_MS = 1500;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

const title = document.querySelector("#previewTitle");
const image = document.querySelector("#previewImage");
const imageFrame = document.querySelector("#imageFrame");
const pointerLayer = document.querySelector("#pointerLayer");
const pointerCursor = pointerLayer.querySelector(".cursor");
const pointerTarget = pointerLayer.querySelector(".target");
const pointerLabel = pointerLayer.querySelector(".label");
const emptyState = document.querySelector("#emptyState");
const capturedAt = document.querySelector("#capturedAt");
const status = document.querySelector("#updateStatus");
const stopButton = document.querySelector("#stopTakeover");

let timer = null;
let requestInFlight = false;
let stopped = false;
let shownCapturedAt = 0;
let loadingCapturedAt = 0;
let lastRippleAt = 0;

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
  pointerLayer.hidden = true;
  emptyState.hidden = false;
  emptyState.textContent = "正在返回原页…";
  capturedAt.hidden = true;
  setStatus("代理已停止，正在返回原页。", "inactive");
}

function spawnRipple(x, y) {
  const ripple = document.createElement("div");
  ripple.className = "ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  pointerLayer.append(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  window.setTimeout(() => ripple.remove(), 500);
}

function renderPointer(response) {
  const pointer = response.pointer;
  const fresh = pointer && Number.isFinite(pointer.at) ? Date.now() - pointer.at <= POINTER_TTL_MS : false;
  if (!fresh || image.hidden) {
    pointerLayer.hidden = true;
    return;
  }
  const origin = imageFrame.getBoundingClientRect();
  const mapped = mapPointerToFrame(pointer, response.viewport, displayedImageBox(image));
  if (!mapped) {
    pointerLayer.hidden = true;
    return;
  }
  const x = mapped.x - origin.x;
  const y = mapped.y - origin.y;
  pointerLayer.hidden = false;
  pointerCursor.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1)`;
  if (mapped.rect) {
    pointerTarget.hidden = false;
    pointerTarget.style.left = `${mapped.rect.x - origin.x}px`;
    pointerTarget.style.top = `${mapped.rect.y - origin.y}px`;
    pointerTarget.style.width = `${mapped.rect.width}px`;
    pointerTarget.style.height = `${mapped.rect.height}px`;
  } else {
    pointerTarget.hidden = true;
  }
  if (mapped.label) {
    pointerLabel.hidden = false;
    pointerLabel.textContent = mapped.label;
    const box = pointerLabel.getBoundingClientRect();
    pointerLabel.style.left = `${x < origin.width / 2 ? Math.max(8, origin.width - box.width - 8) : 8}px`;
    pointerLabel.style.top = `${y < 60 ? Math.max(8, origin.height - box.height - 8) : 8}px`;
  } else {
    pointerLabel.hidden = true;
  }
  if (mapped.kind === "click" && pointer.at !== lastRippleAt) {
    lastRippleAt = pointer.at;
    spawnRipple(x, y);
  }
}

function showImage(dataUrl, capturedAtMs) {
  if (capturedAtMs === shownCapturedAt || capturedAtMs === loadingCapturedAt) return;
  loadingCapturedAt = capturedAtMs;
  const loader = new Image();
  loader.onload = () => {
    if (capturedAtMs < shownCapturedAt) return;
    image.src = dataUrl;
    image.hidden = false;
    emptyState.hidden = true;
    shownCapturedAt = capturedAtMs;
  };
  loader.src = dataUrl;
}

function renderPreview(response) {
  if (!response || response.active !== true) {
    showInactive();
    return;
  }

  stopped = false;
  if (typeof response.title === "string") title.textContent = response.title || "未命名页面";
  if (typeof response.image === "string" && JPEG_DATA_URL.test(response.image) && Number.isFinite(response.capturedAt)) {
    showImage(response.image, response.capturedAt);
  }
  if (Number.isFinite(response.capturedAt)) {
    capturedAt.hidden = false;
    capturedAt.dateTime = new Date(response.capturedAt).toISOString();
    capturedAt.textContent = new Date(response.capturedAt).toLocaleTimeString();
  }
  renderPointer(response);
  if (typeof response.error === "string" && response.error) {
    setStatus("画面未更新：远程画面暂时不可用。", "error");
  } else {
    setStatus("代理在后台执行。指针在预览上移动，不代表操作已成功。", "");
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
