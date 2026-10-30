/**
 * GET /api/health — for an uptime monitor (UptimeRobot, Better Stack, …).
 * 200 {"ok":true} when the site and the database answer; 503 when the
 * database read fails, so the monitor alerts on a Supabase outage too, not
 * just a Cloudflare one. Public, read-only, no secrets, never cached.
 */
const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

export async function onRequestGet() {
  const started = Date.now();
  let db = false;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/cities?select=id&limit=1`, { headers: { apikey: SUPABASE_KEY }, signal: ctl.signal });
    clearTimeout(t);
    db = r.ok && Array.isArray(await r.json());
  } catch { db = false; }
  return new Response(JSON.stringify({ ok: db, db, ms: Date.now() - started, time: new Date().toISOString() }), {
    status: db ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
