import { isTaskRequest } from "../../extension/protocol.js";
import { pingSocket, sendRpc } from "./rpc.js";
const MAX_BODY_SIZE = 128 * 1024;
const MAX_RESPONSE_SIZE = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const READ_RPC_TIMEOUT_MS = 8_000;
const DEVICE_AUTH_TIMEOUT_MS = 5_000;
const STALE_MS = 22_000;
const PING_TIMEOUT_MS = 2_000;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function errorPayload(code, message, { status = 500, retryable = false, details } = {}) {
  const payload = { ok: false, code, error: message, message, status, retryable };
  if (details !== undefined) payload.details = details;
  return payload;
}

function bearerToken(headers) {
  const auth = headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : "";
}

async function readJson(request) {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  if (reader) {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, RPC_TIMEOUT_MS);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (timedOut) throw Object.assign(new Error("Request body timed out"), { status: 408, code: "request_body_timeout" });
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_SIZE) {
          void reader.cancel().catch(() => {});
          throw Object.assign(new Error("Request body too large"), { status: 413, code: "request_body_too_large" });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { clearTimeout(timer); reader.releaseLock(); }
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("Invalid JSON in request body"), { status: 400, code: "invalid_json" }); }
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveRouteId(secret) {
  const data = new TextEncoder().encode(String(secret));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

function safeEqualString(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isRouteId(value) {
  return /^[A-Za-z0-9_-]{10,}$/.test(String(value || ""));
}

function isSecret(value) {
  return /^[A-Za-z0-9_-]{16,}$/.test(String(value || ""));
}

function websocketPair() {
  const pair = new WebSocketPair();
  const values = Object.values(pair);
  return { client: values[0], server: values[1] };
}

export class BrowserRelayDevice {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.deviceSocket = null;
    this.connectedAt = null;
    this.lastSeen = null;
    this.hello = null;
    this.pending = new Map();
    this.authenticatingSockets = new Set();
    // In-memory only — nothing is persisted. A route exists only while its device
    // is connected (the DO stays resident on the open WS); once it drops and the DO
    // evicts, all state is gone. No storage writes → no zombie routes to clean up.
    this.secretHash = null;
    this.staleMs = STALE_MS;
    this.pingTimeoutMs = PING_TIMEOUT_MS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/device/connect") return await this.handleDeviceConnect(request, url);
      if (url.pathname === "/v1/rpc") return await this.handleRpc(request);
      if (url.pathname === "/v1/status") return await this.handleStatus(request);
      return jsonResponse(errorPayload("endpoint_not_found", `Unknown device endpoint: ${url.pathname}`, { status: 404 }), 404);
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || "internal_error";
      return jsonResponse(errorPayload(code, err instanceof Error ? err.message : String(err), { status }), status);
    }
  }

  // secretHash lives only in memory. The device's connect claims it (claim: true);
  // CLI rpc/status must match a live claim — no device connected means no claim,
  // which reads as "offline" rather than silently registering a credential.
  async authorize(secret, { claim = false, routeId = "" } = {}) {
    if (!isSecret(secret)) {
      return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or missing remote device credentials" };
    }
    if (!isRouteId(routeId) || !safeEqualString(routeId, await deriveRouteId(secret))) {
      return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or revoked remote device id" };
    }
    const incomingHash = await sha256Hex(secret);
    if (!this.secretHash) {
      if (claim) { this.secretHash = incomingHash; return { ok: true, claimed: true }; }
      return { ok: false, status: 409, code: "remote_device_offline", message: "Remote Browser Relay device is offline", retryable: true };
    }
    if (!safeEqualString(this.secretHash, incomingHash)) {
      return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or revoked remote device id" };
    }
    return { ok: true, claimed: false };
  }

  async handleDeviceConnect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonResponse(errorPayload("upgrade_required", "WebSocket upgrade required", { status: 426 }), 426);
    }
    if (this.authenticatingSockets.size >= 10) {
      return jsonResponse(errorPayload("connection_limit", "Too many unauthenticated connections", { status: 429 }), 429);
    }
    const { client, server } = websocketPair();
    server.accept();
    this.authenticatingSockets.add(server);
    let authenticated = false, authenticating = false, closed = false;
    const cleanup = () => {
      closed = true;
      clearTimeout(authTimer);
      this.authenticatingSockets.delete(server);
      this.handleDeviceClose(server);
    };
    const close = (code, reason) => { cleanup(); server.close(code, reason); };
    const authTimer = setTimeout(() => {
      if (!authenticated) close(4008, "authentication timeout");
    }, DEVICE_AUTH_TIMEOUT_MS);

    const authenticate = async (secret) => {
      if (authenticated) return true;
      if (authenticating || closed) return false;
      authenticating = true;
      const auth = await this.authorize(secret, { claim: true, routeId: url.searchParams.get("routeId") || "" });
      if (closed) return false;
      if (!auth.ok) {
        close(4003, "authentication failed");
        return false;
      }
      if (this.deviceSocket && this.deviceSocket !== server) {
        const previous = this.deviceSocket;
        this.handleDeviceClose(previous);
        try { previous.close(4001, "superseded"); } catch {}
      }
      this.deviceSocket = server;
      this.hello = null;
      this.connectedAt = new Date().toISOString();
      this.lastSeen = this.connectedAt;
      authenticated = true;
      this.authenticatingSockets.delete(server);
      clearTimeout(authTimer);
      server.send(JSON.stringify({ type: "device.authenticated" }));
      return true;
    };

    const legacySecret = url.searchParams.get("token") || bearerToken(request.headers);
    if (legacySecret && !(await authenticate(legacySecret))) {
      return new Response(null, { status: 101, webSocket: client });
    }

    server.addEventListener("message", (event) => {
      void (async () => {
        if (closed) return;
        if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > (authenticated ? MAX_RESPONSE_SIZE : MAX_BODY_SIZE)) {
          if (authenticated) this.handleDeviceClose(server, "response_body_too_large");
          close(1009, "message too large");
          return;
        }
        let msg;
        try { msg = JSON.parse(event.data); } catch { close(1007, "invalid JSON"); return; }
        if (!msg || typeof msg !== "object") { close(1007, "invalid message"); return; }
        if (!authenticated) {
          if (msg.type === "device.auth" && typeof msg.secret === "string") await authenticate(msg.secret);
          else {
            close(4003, "authenticate first");
          }
          return;
        }
        if (msg.type === "device.auth") return;
        this.handleDeviceMessage(server, event.data);
      })().catch(() => close(1011, "connection failed"));
    });
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleDeviceMessage(socket, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); }
    catch { return; }
    if (this.deviceSocket !== socket) return;
    this.lastSeen = new Date().toISOString();

    if (msg.type === "device.hello") {
      this.hello = msg;
      return;
    }

    if ((msg.type === "rpc.response" || msg.type === "device.pong") && msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      pending.resolve(msg);
    }
  }

  handleDeviceClose(socket, code = "remote_device_offline") {
    if (this.deviceSocket !== socket) return;
    this.deviceSocket = null;
    this.lastSeen = new Date().toISOString();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(errorPayload(code, code === "response_body_too_large" ? "Remote response exceeds size limit; reduce screenshot dimensions" : "Remote Browser Relay device disconnected", { status: code === "response_body_too_large" ? 413 : 409, retryable: code !== "response_body_too_large" }));
      this.pending.delete(id);
    }
  }

  async handleRpc(request) {
    const body = await readJson(request);
    const secret = bearerToken(request.headers);
    const auth = await this.authorize(secret, { routeId: String(body.routeId || "") });
    if (!auth.ok) return jsonResponse(errorPayload(auth.code, auth.message, { status: auth.status }), auth.status);
    if (!body.method || !body.path) {
      return jsonResponse(errorPayload("invalid_request", "method and path are required", { status: 400 }), 400);
    }

    try {
      const response = await this.sendRpcToDevice(body, request.signal);
      const status = Number(response.status) || 200;
      if (typeof response.body === "string") {
        return new Response(response.body, {
          status,
          headers: {
            "Content-Type": response.headers?.["content-type"] || response.headers?.["Content-Type"] || "text/plain",
            "Cache-Control": "no-store",
          },
        });
      }
      return jsonResponse(response.body ?? null, status);
    } catch (err) {
      const payload = err && typeof err === "object" && "code" in err
        ? err
        : errorPayload("remote_rpc_failed", err instanceof Error ? err.message : String(err), { status: 502, retryable: true });
      return jsonResponse(payload, payload.status || 502);
    }
  }

  isSocketLive() {
    return !!this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN;
  }

  isLastSeenStale() {
    const seen = Date.parse(this.lastSeen || "");
    return !Number.isFinite(seen) || Date.now() - seen > this.staleMs;
  }

  dropDevice(reason = "stale") {
    const socket = this.deviceSocket;
    if (!socket) return;
    try { socket.close(4002, reason); } catch {}
    this.handleDeviceClose(socket);
  }

  async sendRpcToDevice(requestBody, signal) {
    if (!this.isSocketLive()) {
      throw errorPayload("remote_device_offline", "Remote Browser Relay device is offline", { status: 409, retryable: true });
    }
    if (this.isLastSeenStale()) {
      const socket = this.deviceSocket;
      try {
        await pingSocket(this.deviceSocket, this.pending, { signal, timeoutMs: this.pingTimeoutMs });
      } catch (error) {
        if (error.code === "remote_device_busy" || error.code === "request_cancelled") throw error;
        if (this.deviceSocket === socket) this.dropDevice("stale");
        throw errorPayload("remote_device_offline", "Remote Browser Relay device is offline", { status: 409, retryable: true });
      }
    }
    const path = new URL(requestBody.path, "http://relay.local").pathname;
    const timeoutMs = isTaskRequest(requestBody.method, path) || path === "/api/screenshot"
      ? RPC_TIMEOUT_MS : READ_RPC_TIMEOUT_MS;
    return sendRpc(this.deviceSocket, this.pending, requestBody, { signal, timeoutMs });
  }

  async handleStatus(request) {
    const routeId = new URL(request.url).searchParams.get("routeId") || "";
    const secret = bearerToken(request.headers);
    const auth = await this.authorize(secret, { routeId });
    if (!auth.ok) return jsonResponse(errorPayload(auth.code, auth.message, { status: auth.status }), auth.status);
    return jsonResponse({
      ok: true,
      routeId,
      connected: !!this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      hello: this.hello,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/health")) {
        return jsonResponse({ ok: true, service: "browser-relay-hub", host: url.host });
      }

      if (request.method === "GET" && url.pathname === "/v1/device/connect") {
        const routeId = url.searchParams.get("routeId") || "";
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(request);
      }

      if (request.method === "POST" && url.pathname === "/v1/rpc") {
        const body = await readJson(request);
        const routeId = String(body.routeId || "");
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(new Request("https://device.local/v1/rpc", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
          signal: request.signal,
        }));
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/status/")) {
        const routeId = decodeURIComponent(url.pathname.slice("/v1/status/".length));
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(new Request(`https://device.local/v1/status?routeId=${encodeURIComponent(routeId)}`, {
          method: "GET",
          headers: request.headers,
        }));
      }

      return jsonResponse(errorPayload("endpoint_not_found", `Unknown hub endpoint: ${url.pathname}`, { status: 404 }), 404);
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || "internal_error";
      return jsonResponse(errorPayload(code, err instanceof Error ? err.message : String(err), { status }), status);
    }
  },
};
