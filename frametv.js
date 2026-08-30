// ---------- shared helpers ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Samsung Frame TV Art Mode client ----------
// Protocol reverse-engineered by the samsungtvws Python library
// (https://github.com/xchwarze/samsung-tv-ws-api). Everything here runs over
// the browser WebSocket API directly against the TV on the local network —
// there's no server component. That works for pairing, browsing, selecting,
// and art-mode toggling, all of which are plain JSON request/response frames.
// Newer TV firmwares require a second raw TCP ("D2D") socket for uploads,
// which browsers can't open — uploadImage() only works on TVs still running
// Art API 0.97, which accepts the image inline over this same WebSocket.
const FRAMETV_ART_APP = "com.samsung.art-app";
const FRAMETV_CLIENT_NAME = "LifeOS";

function frametvB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

class FrameTVUnsupportedUploadError extends Error {}

class FrameTVClient {
  constructor({ ip, port, token }) {
    this.ip = ip;
    this.port = port || 8002;
    this.token = token || null;
    this.ws = null;
    this.pending = new Map(); // request id -> { resolve, reject, waitForSubEvent }
  }

  _wsUrl() {
    const params = new URLSearchParams({ name: frametvB64(FRAMETV_CLIENT_NAME) });
    if (this.token) params.set("token", this.token);
    return `wss://${this.ip}:${this.port}/api/v2/channels/${FRAMETV_ART_APP}?${params.toString()}`;
  }

  connect(timeoutMs = 20000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve({ token: this.token });

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this._wsUrl());
      } catch (e) {
        reject(new Error("That doesn't look like a valid TV address."));
        return;
      }

      const timer = setTimeout(() => {
        finish(new Error("Connection timed out. If this is your first time pairing, check the TV screen for an Allow prompt and confirm it with your remote."));
      }, timeoutMs);

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

      ws.addEventListener("error", () => {
        finish(new Error(`Could not reach the TV at ${this.ip}:${this.port}. Confirm the IP/port, that this device is on the same network, and that you've trusted the TV's certificate (open the link above once in this browser).`));
      });

      ws.addEventListener("close", () => {
        if (!settled) finish(new Error("Connection closed before pairing finished."));
        else this.ws = null;
      });

      ws.addEventListener("message", (evt) => {
        let frame;
        try { frame = JSON.parse(evt.data); } catch { return; }

        if (!settled) {
          if (frame.event === "ms.channel.unauthorized") {
            finish(new Error("Pairing was denied on the TV."));
          } else if (frame.event === "ms.channel.connect") {
            const newToken = frame.data && frame.data.token;
            if (newToken) this.token = newToken;
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
    const reqId = payload.request_id || payload.id;
    const entry = this.pending.get(reqId);
    if (!entry) return;

    if (payload.event === "error") {
      this.pending.delete(reqId);
      entry.reject(new Error(`The TV reported an error (code ${payload.error_code ?? "unknown"}).`));
      return;
    }
    if (!entry.waitForSubEvent || payload.event === entry.waitForSubEvent) {
      this.pending.delete(reqId);
      entry.resolve(payload);
    }
  }

  sendArtRequest(data, { waitForSubEvent, timeoutMs = 10000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the TV."));
    }
    const id = crypto.randomUUID();
    const payload = { ...data, id, request_id: id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for the TV to respond to "${data.request}".`));
        }
      }, timeoutMs);
      this.pending.set(id, {
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

  async getApiVersion() {
    try {
      const data = await this.sendArtRequest({ request: "api_version" });
      return data.version;
    } catch {
      const data = await this.sendArtRequest({ request: "get_api_version" });
      return data.version;
    }
  }

  async getMatteList() {
    const data = await this.sendArtRequest({ request: "get_matte_list" });
    const raw = data.matte_type_list || data.matte_list;
    return raw ? JSON.parse(raw) : [];
  }

  selectImage(contentId, { category = null, show = true } = {}) {
    return this.sendArtRequest({ request: "select_image", category_id: category, content_id: contentId, show });
  }

  setArtMode(on) {
    return this.sendArtRequest({ request: "set_artmode_status", value: on ? "on" : "off" });
  }

  // Only works on TVs still running Art API 0.97 — see the file-level comment.
  async uploadImage(bytes, { fileType = "jpg", matte = "shadowbox_polar" } = {}) {
    let version = null;
    try { version = await this.getApiVersion(); } catch {}
    if (version !== "0.97") {
      throw new FrameTVUnsupportedUploadError(
        "This TV's firmware needs a local-network relay to receive uploads — a direct browser connection can't open the raw socket its Art Mode protocol requires for newer firmware. Ask Claude to build a small local relay service if you want this to work on this TV."
      );
    }

    const id = crypto.randomUUID();
    const ftLower = fileType.toLowerCase();
    const ftHdr = ftLower === "jpg" || ftLower === "jpeg" ? "JPEG" : fileType.toUpperCase();
    const inner = { request: "send_image", file_type: ftHdr, matte_id: matte || "none", id };
    const outer = {
      method: "ms.channel.emit",
      params: { data: JSON.stringify(inner), to: "host", event: "art_app_request" },
    };
    const header = new TextEncoder().encode(JSON.stringify(outer));
    if (header.length > 0xffff) throw new Error("Upload header too large.");
    const lenPrefix = new Uint8Array(2);
    new DataView(lenPrefix.buffer).setUint16(0, header.length, false);

    const donePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Timed out waiting for the TV to finish adding the image."));
        }
      }, 30000);
      this.pending.set(id, {
        waitForSubEvent: "image_added",
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });

    this.ws.send(new Blob([lenPrefix, header, bytes]));
    const done = await donePromise;
    return done.content_id;
  }
}

// ---------- public art API sources ----------
// Each source is fetched a page at a time (FRAMETV_PAGE_SIZE per page) so
// "Load more" can pull in additional results without re-fetching what's
// already showing. `category` is normalized from each API's own type/medium
// field (all three happen to use plain English terms like "Painting"), which
// powers the category facet sidebar.
const FRAMETV_PAGE_SIZE = 24;

async function fetchArticPage(query, page) {
  const params = new URLSearchParams({
    q: query || "painting",
    fields: "id,title,artist_display,image_id,artwork_type_title",
    limit: String(FRAMETV_PAGE_SIZE),
    page: String(page),
  });
  const res = await fetch(`https://api.artic.edu/api/v1/artworks/search?${params}`);
  if (!res.ok) throw new Error("Art Institute of Chicago search failed.");
  const json = await res.json();
  return (json.data || [])
    .filter((a) => a.image_id)
    .map((a) => ({
      key: `artic:${a.id}`,
      source: "Art Institute of Chicago",
      category: a.artwork_type_title || "Other",
      title: a.title || "Untitled",
      artist: a.artist_display || "Unknown artist",
      thumbUrl: `https://www.artic.edu/iiif/2/${a.image_id}/full/400,/0/default.jpg`,
      imageUrl: `https://www.artic.edu/iiif/2/${a.image_id}/full/1686,/0/default.jpg`,
      sourceUrl: `https://www.artic.edu/artworks/${a.id}`,
    }));
}

// The Met's search endpoint returns every matching object id at once (no
// paging), so we fetch a large id list once per search and page through it
// locally, doing a detail fetch (which is where image/title/etc. live) only
// for the ids in the current window.
async function fetchMetArtIds(query) {
  const searchParams = new URLSearchParams({ q: query || "painting", hasImages: "true" });
  const res = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?${searchParams}`);
  if (!res.ok) throw new Error("The Met search failed.");
  const json = await res.json();
  return (json.objectIDs || []).slice(0, 200);
}

async function fetchMetArtDetails(ids) {
  const objects = await Promise.all(
    ids.map((id) =>
      fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  );
  return objects
    .filter((o) => o && o.primaryImageSmall && o.isPublicDomain)
    .map((o) => ({
      key: `met:${o.objectID}`,
      source: "The Met",
      category: o.objectName || "Other",
      title: o.title || "Untitled",
      artist: o.artistDisplayName || "Unknown artist",
      thumbUrl: o.primaryImageSmall,
      imageUrl: o.primaryImage || o.primaryImageSmall,
      sourceUrl: o.objectURL,
    }));
}

async function fetchClevelandPage(query, skip) {
  const params = new URLSearchParams({ q: query || "painting", has_image: "1", limit: String(FRAMETV_PAGE_SIZE), skip: String(skip) });
  const res = await fetch(`https://openaccess-api.clevelandart.org/api/artworks/?${params}`);
  if (!res.ok) throw new Error("Cleveland Museum of Art search failed.");
  const json = await res.json();
  return (json.data || [])
    .filter((a) => a.images && (a.images.web || a.images.print))
    .map((a) => ({
      key: `cma:${a.id}`,
      source: "Cleveland Museum of Art",
      category: a.type || "Other",
      title: a.title || "Untitled",
      artist: (a.creators && a.creators[0] && a.creators[0].description) || "Unknown artist",
      thumbUrl: (a.images.web && a.images.web.url) || a.images.print.url,
      imageUrl: (a.images.print && a.images.print.url) || a.images.web.url,
      sourceUrl: a.url,
    }));
}

// ---------- Frame TV tab state + UI ----------
let frameTVClient = null;
let frameTVLoadedOnce = false;
let frameTVSettingsRow = null; // { id, tv_ip, tv_port, token }
let frameTVArtResults = [];
let frameTVCategoryFilter = new Set(); // categories currently checked in the sidebar
let frameTVKnownCategories = new Set(); // categories seen so far this search, so new ones default to checked without re-checking ones the user unchecked
let frameTVPaging = { query: null, articPage: 0, clevelandSkip: 0, metIds: [], metOffset: 0 };
let frameTVMatteOptions = [
  { matte_id: "none", matte_type: "None" },
  { matte_id: "shadowbox_polar", matte_type: "Shadowbox (Polar)" },
  { matte_id: "shadowbox_black", matte_type: "Shadowbox (Black)" },
  { matte_id: "modernthin_polar", matte_type: "Modern Thin (Polar)" },
  { matte_id: "flexible_polar", matte_type: "Flexible (Polar)" },
];

async function loadFrameTVData() {
  if (!frameTVLoadedOnce) {
    updateFrameTVTrustCertLink();

    const { data, error } = await sb.from("frame_tv_settings").select("*").limit(1).maybeSingle();
    if (!error && data) {
      frameTVSettingsRow = data;
      document.getElementById("frametvIp").value = data.tv_ip || "";
      document.getElementById("frametvPort").value = data.tv_port || 8002;
      updateFrameTVTrustCertLink();
      if (data.tv_ip && data.token) connectFrameTV({ silent: true });
    }

    frameTVLoadedOnce = true;
  }

  loadFrameTVArt();
}

function setFrameTVStatus(text, kind) {
  const el = document.getElementById("frametvStatus");
  el.textContent = text;
  el.style.color = kind === "ok" ? "var(--accent)" : kind === "error" ? "var(--danger)" : "";
}

function updateFrameTVTrustCertLink() {
  const ip = document.getElementById("frametvIp").value.trim();
  const port = document.getElementById("frametvPort").value.trim() || "8002";
  const link = document.getElementById("frametvTrustCertLink");
  if (ip) {
    link.href = `https://${ip}:${port}`;
    link.textContent = `https://${ip}:${port}`;
  } else {
    link.href = "#";
    link.textContent = "https://<tv-ip>:8002";
  }
}

async function saveFrameTVSettings(fields) {
  const payload = {
    tv_ip: fields.tv_ip,
    tv_port: fields.tv_port,
    token: fields.token,
    client_name: FRAMETV_CLIENT_NAME,
    updated_at: new Date().toISOString(),
  };
  if (frameTVSettingsRow && frameTVSettingsRow.id) {
    const { data, error } = await sb.from("frame_tv_settings").update(payload).eq("id", frameTVSettingsRow.id).select().maybeSingle();
    if (!error) frameTVSettingsRow = data;
  } else {
    const { data, error } = await sb.from("frame_tv_settings").insert(payload).select().maybeSingle();
    if (!error) frameTVSettingsRow = data;
  }
}

async function connectFrameTV({ silent = false } = {}) {
  const ip = document.getElementById("frametvIp").value.trim();
  const port = parseInt(document.getElementById("frametvPort").value, 10) || 8002;
  if (!ip) {
    setFrameTVStatus("Enter your TV's IP address first.", "error");
    return;
  }

  if (frameTVClient) frameTVClient.disconnect();
  const savedToken = frameTVSettingsRow && frameTVSettingsRow.tv_ip === ip ? frameTVSettingsRow.token : null;
  frameTVClient = new FrameTVClient({ ip, port, token: savedToken });

  setFrameTVStatus(
    silent ? "Reconnecting…" : "Connecting… if this is your first time pairing, check the TV screen for an Allow prompt.",
    null
  );

  try {
    const { token } = await frameTVClient.connect();
    await saveFrameTVSettings({ tv_ip: ip, tv_port: port, token });
    setFrameTVStatus("Connected ✓", "ok");
    frameTVClient.getMatteList().then((list) => {
      if (list && list.length) frameTVMatteOptions = list;
    }).catch(() => {});
  } catch (e) {
    setFrameTVStatus(e.message, "error");
  }
}

document.getElementById("frametvSettingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  connectFrameTV();
});
document.getElementById("frametvIp").addEventListener("input", updateFrameTVTrustCertLink);
document.getElementById("frametvPort").addEventListener("input", updateFrameTVTrustCertLink);

// ---------- art browsing ----------
document.getElementById("frametvSearchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  loadFrameTVArt();
});

function frameTVEnabledSources() {
  return {
    artic: document.getElementById("frametvSourceArtic").checked,
    met: document.getElementById("frametvSourceMet").checked,
    cleveland: document.getElementById("frametvSourceCleveland").checked,
  };
}

// Fetches the next page from each enabled source given the current
// frameTVPaging cursors, advancing those cursors as it goes. `freshMet`
// re-runs the Met id search (only needed on a brand new search, not a
// "load more") since the Met id list is paged through locally afterward.
async function fetchFrameTVBatch(query, sources, { freshMet }) {
  const fetchers = [];
  if (sources.artic) {
    frameTVPaging.articPage += 1;
    fetchers.push(fetchArticPage(query, frameTVPaging.articPage).catch((e) => { console.error(e); return []; }));
  }
  if (sources.met) {
    fetchers.push((async () => {
      if (freshMet) {
        frameTVPaging.metIds = await fetchMetArtIds(query).catch(() => []);
        frameTVPaging.metOffset = 0;
      }
      const batch = frameTVPaging.metIds.slice(frameTVPaging.metOffset, frameTVPaging.metOffset + FRAMETV_PAGE_SIZE);
      frameTVPaging.metOffset += FRAMETV_PAGE_SIZE;
      return fetchMetArtDetails(batch).catch((e) => { console.error(e); return []; });
    })());
  }
  if (sources.cleveland) {
    fetchers.push(fetchClevelandPage(query, frameTVPaging.clevelandSkip).catch((e) => { console.error(e); return []; }));
    frameTVPaging.clevelandSkip += FRAMETV_PAGE_SIZE;
  }
  return (await Promise.all(fetchers)).flat();
}

async function loadFrameTVArt() {
  const query = document.getElementById("frametvSearchInput").value.trim();
  const statusEl = document.getElementById("frametvArtStatus");
  const gridEl = document.getElementById("frametvArtGrid");
  const loadMoreBtn = document.getElementById("frametvLoadMoreBtn");
  const sources = frameTVEnabledSources();

  if (!sources.artic && !sources.met && !sources.cleveland) {
    statusEl.textContent = "Select at least one source.";
    gridEl.innerHTML = "";
    loadMoreBtn.classList.add("hidden");
    return;
  }

  statusEl.textContent = "Searching…";
  gridEl.innerHTML = "";
  frameTVArtResults = [];
  frameTVCategoryFilter = new Set();
  frameTVKnownCategories = new Set();
  frameTVPaging = { query, articPage: 0, clevelandSkip: 0, metIds: [], metOffset: 0 };

  frameTVArtResults = await fetchFrameTVBatch(query, sources, { freshMet: true });

  if (!frameTVArtResults.length) {
    statusEl.textContent = "No public-domain images found — try a different search.";
    document.getElementById("frametvCategoryFacets").innerHTML = "";
    loadMoreBtn.classList.add("hidden");
    return;
  }
  renderFrameTVCategoryFacets();
  renderFrameTVArtGrid();
  updateFrameTVArtStatusCount(getFilteredFrameTVResults().length);
  loadMoreBtn.classList.remove("hidden");
}

async function loadMoreFrameTVArt() {
  const btn = document.getElementById("frametvLoadMoreBtn");
  if (btn.disabled) return; // guard against duplicate/rapid-repeat clicks firing a second fetch
  const sources = frameTVEnabledSources();
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const more = await fetchFrameTVBatch(frameTVPaging.query, sources, { freshMet: false });
    const existingKeys = new Set(frameTVArtResults.map((a) => a.key));
    frameTVArtResults = frameTVArtResults.concat(more.filter((a) => !existingKeys.has(a.key)));
    renderFrameTVCategoryFacets();
    renderFrameTVArtGrid();
    updateFrameTVArtStatusCount(getFilteredFrameTVResults().length);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load more";
  }
}

document.getElementById("frametvLoadMoreBtn").addEventListener("click", loadMoreFrameTVArt);

// Some source CDNs intermittently block hotlinked images (the Art Institute
// of Chicago's currently 403s on every request via Cloudflare bot
// protection, a known outage on their end — see
// https://github.com/lovasoa/dezoomify/issues/911). Rather than show broken
// image icons, drop those cards and keep the visible count honest.
function updateFrameTVArtStatusCount(count) {
  const statusEl = document.getElementById("frametvArtStatus");
  statusEl.textContent = count
    ? `${count} result${count === 1 ? "" : "s"}`
    : "No images could be loaded — try a different search or source.";
}

["frametvSourceArtic", "frametvSourceMet", "frametvSourceCleveland"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => loadFrameTVArt());
});

// ---------- category facets ----------
function getFilteredFrameTVResults() {
  return frameTVArtResults.filter((a) => frameTVCategoryFilter.has(a.category));
}

// Broken thumbnails get pruned from frameTVArtResults one at a time as each
// <img> fails, which can happen in a burst right after a render — debounce
// the facet rebuild so counts settle once, instead of thrashing per image.
let frameTVFacetRefreshTimer = null;
function scheduleFrameTVFacetRefresh() {
  clearTimeout(frameTVFacetRefreshTimer);
  frameTVFacetRefreshTimer = setTimeout(renderFrameTVCategoryFacets, 400);
}

function renderFrameTVCategoryFacets() {
  const counts = new Map();
  frameTVArtResults.forEach((a) => counts.set(a.category, (counts.get(a.category) || 0) + 1));

  // Any category we haven't seen yet this search (including ones that show
  // up for the first time via "Load more") defaults to checked; categories
  // the user has already unchecked stay unchecked.
  counts.forEach((_, c) => {
    if (!frameTVKnownCategories.has(c)) {
      frameTVKnownCategories.add(c);
      frameTVCategoryFilter.add(c);
    }
  });

  const categories = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const el = document.getElementById("frametvCategoryFacets");
  el.innerHTML = categories.map((c) => `
    <label class="frametv-facet-item">
      <input type="checkbox" data-category="${escapeHtml(c)}" ${frameTVCategoryFilter.has(c) ? "checked" : ""} />
      <span>${escapeHtml(c)}</span>
      <span class="facet-count">${counts.get(c)}</span>
    </label>
  `).join("");

  el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) frameTVCategoryFilter.add(cb.dataset.category);
      else frameTVCategoryFilter.delete(cb.dataset.category);
      renderFrameTVArtGrid();
      updateFrameTVArtStatusCount(getFilteredFrameTVResults().length);
    });
  });
}

function renderFrameTVArtGrid() {
  const gridEl = document.getElementById("frametvArtGrid");
  const visible = getFilteredFrameTVResults();
  gridEl.innerHTML = visible.map((a) => `
    <div class="art-card" data-art-key="${escapeHtml(a.key)}">
      <img src="${escapeHtml(a.thumbUrl)}" alt="${escapeHtml(a.title)}" loading="lazy" />
      <div class="art-card-meta">
        <div class="art-card-title">${escapeHtml(a.title)}</div>
        <div class="art-card-artist">${escapeHtml(a.artist)}</div>
        <div class="art-card-source">${escapeHtml(a.source)}</div>
      </div>
    </div>
  `).join("");

  gridEl.querySelectorAll(".art-card").forEach((card) => {
    card.addEventListener("click", () => openFrameTVDrawer(card.dataset.artKey));
    card.querySelector("img").addEventListener("error", () => {
      frameTVArtResults = frameTVArtResults.filter((a) => a.key !== card.dataset.artKey);
      card.remove();
      scheduleFrameTVFacetRefresh();
      updateFrameTVArtStatusCount(getFilteredFrameTVResults().length);
    }, { once: true });
  });
}

// ---------- artwork drawer ----------
function openFrameTVDrawer(key) {
  const art = frameTVArtResults.find((a) => a.key === key);
  if (!art) return;

  document.getElementById("frametvDrawerTitle").textContent = art.title;

  const matteOptionsHtml = frameTVMatteOptions.map((m) => {
    const id = m.matte_id || m.id;
    const label = m.matte_type || m.label || id;
    return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
  }).join("");

  document.getElementById("frametvDrawerBody").innerHTML = `
    <img src="${escapeHtml(art.imageUrl)}" alt="${escapeHtml(art.title)}" class="art-drawer-preview" />
    <p class="hint">${escapeHtml(art.artist)} — ${escapeHtml(art.source)}</p>
    <p><a href="${escapeHtml(art.sourceUrl)}" target="_blank" rel="noopener noreferrer">View source ↗</a></p>
    <label>Matte
      <select id="frametvMatteSelect">${matteOptionsHtml}</select>
    </label>
    <button type="button" id="frametvSendBtn">Send to TV</button>
    <p id="frametvSendStatus" class="hint"></p>
  `;

  document.getElementById("frametvSendBtn").addEventListener("click", () => sendFrameTVArt(art));

  document.getElementById("frametvDrawer").classList.add("open");
  document.getElementById("frametvBackdrop").classList.add("open");
}

function closeFrameTVDrawer() {
  document.getElementById("frametvDrawer").classList.remove("open");
  document.getElementById("frametvBackdrop").classList.remove("open");
}

document.getElementById("frametvDrawerCloseBtn").addEventListener("click", closeFrameTVDrawer);
document.getElementById("frametvBackdrop").addEventListener("click", closeFrameTVDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("frametvDrawer").classList.contains("open")) closeFrameTVDrawer();
});

async function sendFrameTVArt(art) {
  const statusEl = document.getElementById("frametvSendStatus");
  const btn = document.getElementById("frametvSendBtn");
  const matte = document.getElementById("frametvMatteSelect").value;

  if (!frameTVClient || !frameTVClient.ws || frameTVClient.ws.readyState !== WebSocket.OPEN) {
    statusEl.textContent = "Not connected — connect to your TV first.";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Fetching image…";
  try {
    const imgRes = await fetch(art.imageUrl);
    if (!imgRes.ok) throw new Error("Couldn't download that image from its source.");
    const contentType = imgRes.headers.get("content-type") || "";
    const fileType = contentType.includes("png") ? "png" : "jpg";
    const bytes = new Uint8Array(await imgRes.arrayBuffer());

    statusEl.textContent = "Uploading to TV…";
    const contentId = await frameTVClient.uploadImage(bytes, { fileType, matte });

    statusEl.textContent = "Displaying on TV…";
    await frameTVClient.selectImage(contentId, { show: true });
    await frameTVClient.setArtMode(true);

    statusEl.textContent = "Sent ✓ — now showing on your Frame TV.";
  } catch (e) {
    statusEl.textContent = e instanceof FrameTVUnsupportedUploadError ? e.message : `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}
