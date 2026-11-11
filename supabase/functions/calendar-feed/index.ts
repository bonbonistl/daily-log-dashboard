// Proxies a Google Calendar "secret address in iCal format" feed so the browser can read it
// (Google doesn't send CORS headers). Only calendar.google.com URLs are fetched, and only
// for people the app's my_access() RPC allows (the admin and invited family members), so this
// can't be used as a general-purpose proxy.
// Deployed to Supabase as `calendar-feed` (verify_jwt on).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Asks the database (as the caller) whether this user is allowed in the app.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const fail = (status: number, msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  // verify_jwt already checked the signature; this restricts it to people allowed in the app.
  if (!(await callerAllowed(req))) return fail(403, "Not allowed");

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
  // Redirects are followed, so make sure we still ended up at Google.
  if (!/(^|\.)google\.com$/.test(new URL(r.url).hostname)) return fail(502, "Unexpected redirect");
  const text = await r.text();
  if (!text.startsWith("BEGIN:VCALENDAR")) return fail(502, "That address didn't return a calendar");
  return new Response(text, { headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8" } });
});
