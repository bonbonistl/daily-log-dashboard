// More public art sources for House > FrameTV, alongside the Art Institute,
// The Met and Cleveland fetchers in frametv.js. Each returns art objects in
// the same shape ({ key, source, category, title, artist, thumbUrl,
// imageUrl, sourceUrl }) and goes through frameTVCachedJson, so repeat
// searches come from the browser cache. Full-size images are requested at
// up to 3840×2160 (the Frame's 4K panel) rather than the original file,
// which can be hundreds of megabytes.

function frameTVStripHtml(html, { dropHidden = false } = {}) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const div = doc.body;
  if (dropHidden) div.querySelectorAll("[style*='display:none'], [style*='display: none']").forEach((el) => el.remove());
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function frameTVCapitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ---------- Rijksmuseum (Amsterdam) ----------
// The search API (Linked Art) returns only object ids, 100 per page with a
// pageToken "next" link; title/artist/image come from one fetch per object.
// A query searches artist names and titles; an empty query lists paintings.
const RIJKS_SEARCH = "https://data.rijksmuseum.nl/search/collection";
const RIJKS_ENGLISH = "http://vocab.getty.edu/aat/300388277";

function frameTVNewRijksState() {
  return { started: false, ids: [], seen: new Set(), idx: 0, next: [] };
}

async function fetchRijksIdPage(url) {
  const json = await frameTVCachedJson(url, FRAMETV_SEARCH_TTL_MS);
  if (!json) throw new Error("Rijksmuseum search failed.");
  return {
    ids: (json.orderedItems || []).map((o) => o.id).filter(Boolean),
    next: json.next && json.next.id ? json.next.id : null,
  };
}

function frameTVEnglishNotation(node) {
  const raw = node && node.notation;
  const notes = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const en = notes.find((n) => n["@language"] === "en") || notes[0];
  return en ? en["@value"] : null;
}

function parseRijksObject(o) {
  if (!o || !o.id) return null;

  // Image: a IIIF service on iiif.micr.io under subject_of, with its license.
  let iiifBase = null;
  let license = "";
  let pageUrl = null;
  for (const s of o.subject_of || []) {
    for (const d of s.digitally_carried_by || []) {
      for (const ap of d.access_point || []) {
        const m = /^(https:\/\/iiif\.micr\.io\/[^/]+)\//.exec(ap.id || "");
        if (m && !iiifBase) {
          iiifBase = m[1];
          license = ((d.referred_to_by || [])[0] || {}).content || "";
        } else if (d.format === "text/html" && !pageUrl) {
          pageUrl = ap.id;
        }
      }
    }
  }
  if (!iiifBase) return null;
  if (license && !/publicdomain|zero/i.test(license)) return null;

  const names = (o.identified_by || []).filter((n) => n.type === "Name" && n.content);
  const enName = names.find((n) => (n.language || []).some((l) => l.id === RIJKS_ENGLISH));
  const title = (enName || names[0] || {}).content || "Untitled";

  const prod = o.produced_by || {};
  const makers = [prod, ...(prod.part || [])].flatMap((p) => p.carried_out_by || []);
  const artist = makers.map(frameTVEnglishNotation).filter(Boolean)[0] || "Unknown artist";

  const category = (o.classified_as || []).map(frameTVEnglishNotation).filter(Boolean)[0] || "Other";

  return {
    key: `rijks:${o.id.split("/").pop()}`,
    source: "Rijksmuseum",
    category: frameTVCapitalize(category),
    title,
    artist,
    thumbUrl: `${iiifBase}/full/400,/0/default.jpg`,
    imageUrl: `${iiifBase}/full/!3840,2160/0/default.jpg`,
    sourceUrl: pageUrl ? pageUrl.replace("/nl/collectie/", "/en/collection/") : o.id,
  };
}

// Returns the next FRAMETV_PAGE_SIZE artworks for this search, advancing `st`.
async function fetchRijksBatch(query, st) {
  if (!st.started) {
    st.started = true;
    const q = (query || "").trim();
    st.next = q
      ? [
          // Artist matches first, so "Vermeer" shows his paintings before
          // prints and photos whose titles mention him.
          `${RIJKS_SEARCH}?${new URLSearchParams({ creator: q, imageAvailable: "true" })}`,
          `${RIJKS_SEARCH}?${new URLSearchParams({ title: q, imageAvailable: "true" })}`,
        ]
      : [`${RIJKS_SEARCH}?${new URLSearchParams({ type: "painting", imageAvailable: "true" })}`];
  }
  while (st.ids.length - st.idx < FRAMETV_PAGE_SIZE && st.next.length) {
    const urls = st.next;
    st.next = [];
    const pages = await Promise.all(urls.map((u) => fetchRijksIdPage(u).catch((e) => { console.error(e); return { ids: [], next: null }; })));
    for (const p of pages) {
      for (const id of p.ids) {
        if (!st.seen.has(id)) { st.seen.add(id); st.ids.push(id); }
      }
      if (p.next) st.next.push(p.next);
    }
  }
  const batch = st.ids.slice(st.idx, st.idx + FRAMETV_PAGE_SIZE);
  st.idx += batch.length;
  const objects = await Promise.all(
    batch.map((id) => frameTVCachedJson(id, FRAMETV_OBJECT_TTL_MS).catch(() => null))
  );
  return objects
    .map((o) => {
      try { return parseRijksObject(o); } catch (e) { console.error("Rijksmuseum object parse failed", e); return null; }
    })
    .filter(Boolean);
}

// ---------- Wikimedia Commons ----------
// Searches file pages for large bitmaps (at least 1920px wide). Commons is
// huge and mixed — expect photos of frames and gallery walls alongside the
// paintings. Images go through thumb.wikimedia.org at a standard 1920/3840
// width; the original-file host rate-limits non-browser downloads (the relay).
async function fetchWikimediaPage(query, offset) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: `${query || "painting"} filetype:bitmap filew:>1919`,
    gsrnamespace: "6",
    gsrlimit: String(FRAMETV_PAGE_SIZE),
    gsroffset: String(offset),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "500",
    iiextmetadatafilter: "ObjectName|Artist|Categories",
    iiextmetadatalanguage: "en",
  });
  const json = await frameTVCachedJson(`https://commons.wikimedia.org/w/api.php?${params}`, FRAMETV_SEARCH_TTL_MS);
  if (!json) throw new Error("Wikimedia Commons search failed.");
  const pages = Object.values((json.query && json.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages
    .map((p) => {
      const info = (p.imageinfo || [])[0];
      if (!info || !info.thumburl || !/jpeg|png/.test(info.mime || "")) return null;
      const thumbUrl = info.thumburl.split("?")[0];
      if (!/\/500px-/.test(thumbUrl)) return null;
      const fullWidth = info.width >= 3840 ? 3840 : 1920;
      const meta = info.extmetadata || {};
      const fileTitle = String(p.title || "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
      // ObjectName can embed hidden Wikidata label markup ("title QS:P1476…").
      let title = frameTVStripHtml(meta.ObjectName && meta.ObjectName.value, { dropHidden: true });
      if (!title || /QS:/.test(title) || title.length > 160) title = fileTitle || "Untitled";
      const artist = frameTVStripHtml(meta.Artist && meta.Artist.value).slice(0, 120) || "Unknown artist";
      const cats = (meta.Categories && meta.Categories.value) || "";
      return {
        key: `wikimedia:${p.pageid}`,
        source: "Wikimedia Commons",
        category: /painting/i.test(cats) ? "Painting" : /photograph/i.test(cats) ? "Photograph" : "Image",
        title,
        artist,
        thumbUrl,
        imageUrl: thumbUrl.replace("/500px-", `/${fullWidth}px-`),
        sourceUrl: info.descriptionurl,
      };
    })
    .filter(Boolean);
}

// ---------- Victoria and Albert Museum (London) ----------
// Mostly decorative arts, prints and drawings; images are free for personal,
// non-commercial use.
async function fetchVamPage(query, page) {
  const params = new URLSearchParams({
    q: query || "painting",
    images_exist: "1",
    page_size: String(FRAMETV_PAGE_SIZE),
    page: String(page),
  });
  const json = await frameTVCachedJson(`https://api.vam.ac.uk/v2/objects/search?${params}`, FRAMETV_SEARCH_TTL_MS);
  if (!json) throw new Error("V&A search failed.");
  return (json.records || [])
    .filter((r) => r._images && r._images._iiif_image_base_url)
    .map((r) => {
      const base = r._images._iiif_image_base_url.replace(/\/?$/, "/");
      return {
        key: `vam:${r.systemNumber}`,
        source: "V&A",
        category: frameTVCapitalize(r.objectType) || "Other",
        title: r._primaryTitle || "Untitled",
        artist: (r._primaryMaker && r._primaryMaker.name) || "Unknown artist",
        thumbUrl: `${base}full/400,/0/default.jpg`,
        imageUrl: `${base}full/!3840,2160/0/default.jpg`,
        sourceUrl: `https://collections.vam.ac.uk/item/${r.systemNumber}/`,
      };
    });
}
