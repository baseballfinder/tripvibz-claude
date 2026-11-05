/**
 * Site-wide cover page during database updates.
 *
 * When a merge to main carries a database migration, the "Cover the site
 * during database updates" workflow (.github/workflows/maintenance-cover.yml)
 * switches public.site_status.maintenance on, waits until the new version is
 * live on Cloudflare and the migration has applied, then switches it off.
 * While it is on, every page a person opens gets the cover page with a 503 and
 * Retry-After, which tells Google "temporarily down, come back" rather than
 * "this is the page now", so search results and snippets are left alone.
 *
 * Never covered: /api/* (the site's own API, uptime checks), /admin.html,
 * anything that isn't a page load (scripts, images, JSON), and anyone who opens
 * any page with ?preview=live (sets a one-hour cookie, to check the real site).
 * /assets/* never reaches this function at all (dist/_routes.json).
 *
 * Every response passed through also gets the security headers (CSP etc.):
 * Cloudflare doesn't promise to apply dist/_headers to responses that go
 * through a Function, and this one now sees every page. withSecurityHeaders()
 * only adds headers that are missing, so where _headers did apply nothing changes.
 *
 * Fails open: if the switch can't be read quickly, the real site is served.
 * The switch also carries an end time, so a stuck workflow can't leave the
 * site covered for more than about 20 minutes.
 */
import { withSecurityHeaders } from "./_security.js";
import { MAINTENANCE_HTML } from "./_maintenance-page.js";

const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";   // public read key
const CHECK_EVERY_MS = 15000;   // each Cloudflare isolate re-reads the switch at most every 15 s
const READ_TIMEOUT_MS = 1500;
const BYPASS_COOKIE = "tv_live";

let cached = { at: -Infinity, row: null };

/** Test hook: forget the cached switch. */
export function _resetCache() { cached = { at: -Infinity, row: null }; }

/** Is the cover on? A row { maintenance, until } -> boolean (until in the past = off). */
export function coverIsOn(row, now = Date.now()) {
  if (!row || row.maintenance !== true) return false;
  if (row.until && Date.parse(row.until) <= now) return false;
  return true;
}

async function readSwitch(now = Date.now(), fetchImpl = fetch) {
  if (now - cached.at < CHECK_EVERY_MS) return cached.row;
  let row = null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/site_status?select=maintenance,until&id=eq.1`,
      { headers: { apikey: SUPABASE_KEY, accept: "application/json" }, signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) { const data = await r.json(); row = Array.isArray(data) ? data[0] || null : null; }
  } catch { row = null; }   // table missing, Supabase slow or down: serve the real site
  cached = { at: now, row };
  return row;
}

/** Would this request get the cover page (when the switch is on)? */
export function coverable(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/assets/") || p === "/admin.html" || p === "/admin/") return false;
  if (url.searchParams.get("preview") === "live") return false;
  if ((request.headers.get("cookie") || "").split(/;\s*/).includes(`${BYPASS_COOKIE}=1`)) return false;
  // Page loads only: browsers send text/html for navigations; scripts, images and fetch() calls don't.
  return (request.headers.get("accept") || "").includes("text/html");
}

export async function onRequest(context, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { request } = context;
  const next = async () => withSecurityHeaders(await context.next());
  if (new URL(request.url).searchParams.get("preview") === "live") {
    const res = await next();
    const h = new Headers(res.headers);
    h.append("set-cookie", `${BYPASS_COOKIE}=1; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  if (!coverable(request)) return next();
  if (!coverIsOn(await readSwitch(now, fetchImpl), now)) return next();
  return withSecurityHeaders(new Response(request.method === "HEAD" ? null : MAINTENANCE_HTML, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "300"
    }
  }));
}
