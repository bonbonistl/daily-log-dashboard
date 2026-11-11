// FrameTV local relay
//
// The browser-based Art Mode client in frametv.js can pair, browse, select,
// and toggle Art Mode entirely over WebSocket — but uploading a new image on
// newer Frame TV firmware requires a second raw TCP ("D2D") socket handshake
// that browsers have no API to open. This relay runs on a normal Node.js
// process (which *can* open raw sockets) on the same home network as the TV,
// and does that half of the protocol on the browser's behalf.
//
// Protocol reverse-engineered by the samsungtvws Python library:
// https://github.com/xchwarze/samsung-tv-ws-api
//
// Usage: npm install && npm start (defaults to port 8787)

const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8787;
const TOKENS_FILE = path.join(__dirname, "tokens.json");

// ---------- access rules ----------
// Only this Mac can reach the relay (it listens on loopback, not the Wi-Fi),
// and only the LifeOS web app may call it from a browser — so other websites
// you visit can't drive your TV or use this Mac to fetch things for them.
// Set RELAY_LISTEN_HOST=0.0.0.0 only if the relay runs on a different machine
// than the browser (see README).
const LISTEN_HOSTS = process.env.RELAY_LISTEN_HOST ? [process.env.RELAY_LISTEN_HOST] : ["127.0.0.1", "::1"];
const APP_ORIGIN = "https://bonbonistl.github.io";
const EXTRA_ORIGINS = (process.env.RELAY_ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // not a browser page (e.g. curl on this Mac)
  if (origin === APP_ORIGIN || EXTRA_ORIGINS.includes(origin)) return true;
  // Local previews of the app on this Mac.
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

// The TV must be on the home network.
function isPrivateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (m.slice(1).some((n) => Number(n) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Art comes from public https museum sites, never from this Mac or the home network.
function isPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10 || (a === 169 && b === 254) || isPrivateIPv4(host)) return false;
  }
  if (host.includes(":")) return false; // raw IPv6 literals aren't needed
  return true;
}
const ART_APP = "com.samsung.art-app";
const CLIENT_NAME = "LifeOS";

// ---------- token persistence (one token per TV IP, so pairing only happens once) ----------
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveToken(tvIp, token) {
  const tokens = loadTokens();
  tokens[tvIp] = token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// ---------- Samsung Frame TV Art Mode client ----------
function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

class SamsungArtClient {
  constructor(tvIp, tvPort) {
    this.tvIp = tvIp;
    this.tvPort = tvPort || 8002;
    this.token = loadTokens()[tvIp] || null;
    this.ws = null;
    this.pending = new Map(); // request id -> { resolve, reject, waitForSubEvent }
    // Some firmware doesn't reliably tag its final "image_added" event with
    // our upload's request id — samsungtvws itself waits for that one with
    // request_uuid=None (id-agnostic), so we mirror that with a separate
    // queue matched on sub-event name alone.
    this.anyIdWaiters = [];
  }

  _wsUrl() {
    const params = new URLSearchParams({ name: b64(CLIENT_NAME) });
    if (this.token) params.set("token", this.token);
    return `wss://${this.tvIp}:${this.tvPort}/api/v2/channels/${ART_APP}?${params.toString()}`;
  }

  connect(timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try { ws.close(); } catch {}
          reject(err);
        } else {
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        finish(new Error("Timed out connecting to the TV. If this is a first-time pairing, check the TV screen for an Allow prompt."));
      }, timeoutMs);

      const ws = new WebSocket(this._wsUrl(), { rejectUnauthorized: false });

      ws.on("error", (err) => finish(new Error(`Could not reach the TV at ${this.tvIp}:${this.tvPort}: ${err.message}`)));
      ws.on("close", () => { if (!settled) finish(new Error("Connection closed before pairing finished.")); else this.ws = null; });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let frame;
        try { frame = JSON.parse(data.toString("utf8")); } catch { return; }

        if (!settled) {
          if (frame.event === "ms.channel.unauthorized") {
            finish(new Error("Pairing was denied on the TV."));
          } else if (frame.event === "ms.channel.connect") {
            const newToken = frame.data && frame.data.token;
            if (newToken) { this.token = newToken; saveToken(this.tvIp, newToken); }
          } else if (frame.event === "ms.channel.ready") {
            this.ws = ws;
            finish(null, { token: this.token });
          }
          return;
        }

        this._handleFrame(frame);
      });
    });
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
  }

  _handleFrame(frame) {
    if (!frame || frame.event !== "d2d_service_message" || typeof frame.data !== "string") return;
    let payload;
    try { payload = JSON.parse(frame.data); } catch { return; }

    if (payload.event === "error") {
      const reqId = payload.request_id || payload.id;
      const entry = this.pending.get(reqId);
      if (entry) {
        this.pending.delete(reqId);
        entry.reject(new Error(`TV reported an error (code ${payload.error_code ?? "unknown"}).`));
      }
      return;
    }

    const reqId = payload.request_id || payload.id;
    const entry = this.pending.get(reqId);
    if (entry && (!entry.waitForSubEvent || payload.event === entry.waitForSubEvent)) {
      this.pending.delete(reqId);
      entry.resolve(payload);
      return;
    }

    const waiterIdx = this.anyIdWaiters.findIndex((w) => w.waitForSubEvent === payload.event);
    if (waiterIdx !== -1) {
      const [waiter] = this.anyIdWaiters.splice(waiterIdx, 1);
      waiter.resolve(payload);
    }
  }

  sendArtRequest(data, { waitForSubEvent, timeoutMs = 15000, id } = {}) {
    const reqId = id || crypto.randomUUID();
    const payload = { ...data, id: reqId, request_id: reqId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          reject(new Error(`Timed out waiting for the TV to respond to "${data.request}".`));
        }
      }, timeoutMs);
      this.pending.set(reqId, {
        waitForSubEvent,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({
        method: "ms.channel.emit",
        params: { event: "art_app_request", to: "host", data: JSON.stringify(payload) },
      }));
    });
  }

  waitForAnySubEvent(waitForSubEvent, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = { waitForSubEvent, resolve: wrappedResolve, reject };
      const timer = setTimeout(() => {
        const idx = this.anyIdWaiters.indexOf(waiter);
        if (idx !== -1) this.anyIdWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for "${waitForSubEvent}".`));
      }, timeoutMs);
      function wrappedResolve(v) { clearTimeout(timer); resolve(v); }
      this.anyIdWaiters.push(waiter);
    });
  }

  selectImage(contentId) {
    return this.sendArtRequest({ request: "select_image", category_id: null, content_id: contentId, show: true });
  }

  setArtMode(on) {
    return this.sendArtRequest({ request: "set_artmode_status", value: on ? "on" : "off" });
  }

  // Newer-firmware upload path: request a D2D socket, then stream the image
  // over a plain (or TLS, if the TV asks for it) TCP connection — this is
  // exactly what a browser can't do, and the entire reason this relay exists.
  async upload(bytes, { fileType = "jpg", matte = "shadowbox_polar" } = {}) {
    const ft = fileType.toLowerCase() === "jpeg" ? "jpg" : fileType.toLowerCase();
    const id = crypto.randomUUID();
    const date = new Date().toISOString().replace("T", " ").slice(0, 19).replace(/-/g, ":");

    const readyPromise = this.sendArtRequest({
      request: "send_image",
      file_type: ft,
      file_size: bytes.length,
      image_date: date,
      matte_id: matte || "none",
      portrait_matte_id: matte || "none",
      conn_info: {
        d2d_mode: "socket",
        connection_id: Math.floor(Math.random() * 4 * 1024 * 1024 * 1024),
        id,
      },
    }, { waitForSubEvent: "ready_to_use", id });

    // Start waiting for the completion event before we write to the D2D
    // socket, so there's no gap where the TV could fire it before we're
    // listening.
    const donePromise = this.waitForAnySubEvent("image_added");

    const ready = await readyPromise;
    let connInfo = ready.conn_info;
    if (typeof connInfo === "string") connInfo = JSON.parse(connInfo);

    const header = Buffer.from(JSON.stringify({
      num: 0,
      total: 1,
      fileLength: bytes.length,
      fileName: "image",
      fileType: ft,
      secKey: connInfo.key,
      version: "0.0.1",
    }), "ascii");
    const headerLen = Buffer.alloc(4);
    headerLen.writeUInt32BE(header.length, 0);

    await new Promise((resolve, reject) => {
      const opts = { host: connInfo.ip, port: Number(connInfo.port) };
      const socket = connInfo.secured
        ? tls.connect({ ...opts, rejectUnauthorized: false }, onConnect)
        : net.connect(opts, onConnect);

      function onConnect() {
        socket.write(headerLen);
        socket.write(header);
        socket.write(bytes, (err) => {
          socket.end();
          if (err) reject(err); else resolve();
        });
      }
      socket.on("error", reject);
    });

    const done = await donePromise;
    return done.content_id;
  }
}

// ---------- HTTP server ----------
function withCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome's Private Network Access check: a public https page calling
  // localhost sends a preflight that must be answered with this header.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function sendJson(req, res, status, body) {
  withCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleRequest(req, res) {
  // Refuse other websites outright. Without this, a page could still trigger a
  // send with a "simple" request even though the browser hides the response.
  if (!isAllowedOrigin(req.headers.origin)) {
    console.warn(`[relay] blocked request from origin ${req.headers.origin}`);
    sendJson(req, res, 403, { ok: false, error: "This site isn't allowed to use the relay." });
    return;
  }

  if (req.method === "OPTIONS") { withCors(req, res); res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      sendJson(req, res, 415, { ok: false, error: "Expected a JSON request." });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(req, res, 400, { ok: false, error: "Invalid request body." });
      return;
    }

    const { tvIp, tvPort, imageUrl, matte } = body;
    if (!tvIp || !imageUrl) {
      sendJson(req, res, 400, { ok: false, error: "tvIp and imageUrl are required." });
      return;
    }
    if (!isPrivateIPv4(tvIp)) {
      sendJson(req, res, 400, { ok: false, error: "The TV address must be a home-network IP like 192.168.1.20." });
      return;
    }
    if (tvPort != null && tvPort !== "" && !/^\d{1,5}$/.test(String(tvPort))) {
      sendJson(req, res, 400, { ok: false, error: "Invalid TV port." });
      return;
    }
    if (!isPublicHttpsUrl(imageUrl)) {
      sendJson(req, res, 400, { ok: false, error: "The image must be a public https:// address." });
      return;
    }

    const client = new SamsungArtClient(tvIp, tvPort);
    try {
      console.log(`[relay] connecting to ${tvIp}:${tvPort || 8002}…`);
      await client.connect();

      console.log(`[relay] downloading ${imageUrl}`);
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Couldn't download the image (HTTP ${imgRes.status}).`);
      const contentType = imgRes.headers.get("content-type") || "";
      const fileType = contentType.includes("png") ? "png" : "jpg";
      const bytes = Buffer.from(await imgRes.arrayBuffer());

      console.log(`[relay] uploading ${bytes.length} bytes to the TV…`);
      const contentId = await client.upload(bytes, { fileType, matte });

      console.log(`[relay] selecting content_id ${contentId}`);
      await client.selectImage(contentId);
      await client.setArtMode(true);

      sendJson(req, res, 200, { ok: true, contentId });
    } catch (err) {
      console.error("[relay] send failed:", err.message);
      sendJson(req, res, 502, { ok: false, error: err.message });
    } finally {
      client.disconnect();
    }
    return;
  }

  sendJson(req, res, 404, { ok: false, error: "Not found." });
}

// Listen on this Mac's loopback addresses only (IPv4 and IPv6, since browsers
// may resolve "localhost" to either), so nothing else on the Wi-Fi can reach it.
let listening = 0;
for (const host of LISTEN_HOSTS) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[relay] unexpected error:", err);
      if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: "Relay error." });
    });
  });
  server.on("error", (err) => {
    console.error(`[relay] couldn't listen on ${host}:${PORT}: ${err.message}`);
    if (host === LISTEN_HOSTS[0]) process.exit(1);
  });
  server.listen(PORT, host, () => {
    if (++listening === 1) {
      console.log(`FrameTV relay listening on http://localhost:${PORT} (this Mac only)`);
      console.log(`Point the LifeOS House > FrameTV settings' "Local relay URL" field at this address.`);
    }
  });
}
