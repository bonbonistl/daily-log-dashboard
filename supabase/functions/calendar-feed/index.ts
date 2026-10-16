// Proxies a Google Calendar "secret address in iCal format" feed so the browser can read it
// (Google doesn't send CORS headers). Only calendar.google.com URLs are fetched, and only
// for the dashboard owner, so this can't be used as a general-purpose proxy.
// Deployed to Supabase as `calendar-feed` (verify_jwt on).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OWNER_EMAIL = "jthorp@gmail.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jwtEmail(req: Request): string | null {
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).email ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const fail = (status: number, msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  // verify_jwt already checked the signature; this restricts it to the owner.
  if (jwtEmail(req) !== OWNER_EMAIL) return fail(403, "Not allowed");

  let url: URL;
  try {
    const body = await req.json();
    url = new URL(String(body.url || "").trim().replace(/^webcal:/i, "https:"));
  } catch { return fail(400, "Missing or invalid url"); }
  if (url.protocol !== "https:" || url.hostname !== "calendar.google.com") {
    return fail(400, "Only calendar.google.com iCal addresses are supported");
  }

  const r = await fetch(url.toString());
  if (!r.ok) return fail(502, `Google returned ${r.status}`);
  const text = await r.text();
  if (!text.startsWith("BEGIN:VCALENDAR")) return fail(502, "That address didn't return a calendar");
  return new Response(text, { headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8" } });
});
