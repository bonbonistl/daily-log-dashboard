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
function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  withCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { withCors(res); res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid request body." });
      return;
    }

    const { tvIp, tvPort, imageUrl, matte } = body;
    if (!tvIp || !imageUrl) {
      sendJson(res, 400, { ok: false, error: "tvIp and imageUrl are required." });
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

      sendJson(res, 200, { ok: true, contentId });
    } catch (err) {
      console.error("[relay] send failed:", err.message);
      sendJson(res, 502, { ok: false, error: err.message });
    } finally {
      client.disconnect();
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found." });
});

server.listen(PORT, () => {
  console.log(`FrameTV relay listening on http://localhost:${PORT}`);
  console.log(`Point the LifeOS House > FrameTV settings' "Local relay URL" field at this address.`);
});
