// Looks up a recipe page's name so the Meals form can fill it in (browsers can't read other
// sites' pages because of CORS). Preference order: schema.org Recipe "name" in the page's
// JSON-LD → og:title → <title>, with " | Site Name" style suffixes trimmed.
//
// Guardrails, since this fetches arbitrary URLs:
//  - only for people the app's my_access() RPC allows (admin + invited family members);
//  - http(s) on default ports only; hostnames that are IP literals, localhost, or that
//    resolve to private/loopback/link-local addresses are refused, re-checked on every redirect;
//  - 8s timeout, first 1.5 MB of HTML only;
//  - only the extracted title goes back to the browser, never the page body.
// Deployed to Supabase as `recipe-title` (verify_jwt on).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;
// Identifies itself honestly. Sites with bot protection may refuse it; the app then falls back to
// naming the recipe from the link's own words.
const UA = "LifeOS-RecipeTitle/1.0 (personal recipe box; fetches one page to read its title)";

async function callerAllowed(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return false;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/my_access`, {
      method: "POST",
      headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY")!, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return false;
    return (await r.json())?.allowed === true;
  } catch { return false; }
}

// ---------- address safety ----------
function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}
function privateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  const v4 = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return privateV4(v4[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(x);
}

async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web links are supported");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("Unsupported port");
  if (u.username || u.password) throw new Error("Unsupported link");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) throw new Error("IP addresses aren't supported");
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) throw new Error("Unsupported host");
  const [a, aaaa] = await Promise.all([
    Deno.resolveDns(host, "A").catch(() => [] as string[]),
    Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
  ]);
  if (!a.length && !aaaa.length) throw new Error("Couldn't find that website");
  if (a.some(privateV4) || aaaa.some(privateV6)) throw new Error("Unsupported host");
}

async function fetchHtml(start: URL): Promise<{ html: string; finalUrl: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const r = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel();
      url = new URL(r.headers.get("location")!, url);
      continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`The site returned ${r.status}`); }
    const type = r.headers.get("content-type") || "";
    if (type && !/html|xml/i.test(type)) { await r.body?.cancel(); throw new Error("That link isn't a web page"); }

    const reader = r.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; if (off >= size) break; }
    return { html: new TextDecoder("utf-8", { fatal: false }).decode(buf), finalUrl: url };
  }
  throw new Error("Too many redirects");
}

// ---------- extraction ----------
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", eacute: "é", egrave: "è", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", reg: "®", trade: "™", deg: "°" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(n) ? m : String.fromCodePoint(n);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const clean = (s: unknown) => (typeof s === "string" ? decodeEntities(decodeEntities(s)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "");

function isRecipe(node: any): boolean {
  const t = node?.["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}
function findRecipeName(node: any, depth = 0): string {
  if (!node || typeof node !== "object" || depth > 6) return "";
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeName(n, depth + 1); if (r) return r; }
    return "";
  }
  if (isRecipe(node) && clean(node.name)) return clean(node.name);
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipeName(node[k], depth + 1);
    if (r) return r;
  }
  return "";
}

function metaContent(html: string, key: string): string {
  // Attribute values may be double-, single- or un-quoted (minified HTML drops quotes).
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']?${key.replace(/[.:]/g, "\\$&")}(?=["'\\s>/])[^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const m = tag?.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag?.match(/\bcontent\s*=\s*'([^']*)'/i) || tag?.match(/\bcontent\s*=\s*([^\s"'>]+)/i);
  return m ? clean(m[1]) : "";
}

// "Creamy Tuscan Chicken | Half Baked Harvest" → "Creamy Tuscan Chicken"
function trimSiteSuffix(title: string, siteName: string): string {
  let t = title;
  if (siteName) {
    const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*[|\\-–—:·•]\\s*${esc}\\s*$`, "i"), "").replace(new RegExp(`^${esc}\\s*[|\\-–—:·•]\\s*`, "i"), "");
  }
  const parts = t.split(/\s+[|–—•·]\s+|\s+-\s+/);
  if (parts.length > 1 && parts[0].length >= 4) t = parts[0];
  return t.trim();
}

function extractTitle(html: string, finalUrl: URL): string {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const name = findRecipeName(JSON.parse(m[1].trim()));
      if (name) return name;
    } catch { /* malformed JSON-LD is common; skip it */ }
  }

  const siteName = metaContent(html, "og:site_name");
  let title = metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (!title) title = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  if (!title) return "";

  // Instagram: 'Some Cook on Instagram: "Crispy gnocchi bake 🔥 Ingredients…"' → caption's first line.
  const ig = title.match(/on Instagram:\s*["“](.+)/i);
  if (ig || /(^|\.)instagram\.com$/.test(finalUrl.hostname)) {
    const caption = (ig?.[1] || "").replace(/["”]\s*$/, "");
    return caption.split(/\s*(?:\n|\.\s|!\s|#)/)[0].slice(0, 120).trim();
  }
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(finalUrl.hostname)) return title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
  return trimSiteSuffix(title, siteName);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (!(await callerAllowed(req))) return json(403, { error: "Not allowed" });

  let url: URL;
  try {
    const body = await req.json();
    let raw = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    url = new URL(raw);
  } catch { return json(400, { error: "Missing or invalid url" }); }

  try {
    const { html, finalUrl } = await fetchHtml(url);
    return json(200, { title: extractTitle(html, finalUrl).slice(0, 200) });
  } catch (e) {
    return json(200, { title: "", error: e instanceof Error ? e.message : "Lookup failed" });
  }
});
