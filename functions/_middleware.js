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
 * It is also where the site log (functions/api/_log.js) watches the server:
 * every request passes here, so a Function that throws, answers 5xx or takes
 * longer than SLOW_MS, and every page that doesn't exist, is logged by
 * watched() below. The logging runs after the response has gone (waitUntil).
 *
 * Fails open: if the switch can't be read quickly, the real site is served.
 * The switch also carries an end time, so a stuck workflow can't leave the
 * site covered for more than about 20 minutes.
 */
import { withSecurityHeaders } from "./_security.js";
import { MAINTENANCE_HTML } from "./_maintenance-page.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./_config.js";
import { device, SLOW_MS } from "./api/_log.js";
import { record, alreadyReported } from "./api/_notify.js";

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

// Addresses nobody was ever sent to: scanners trying other software's doors. Not worth a row.
const SCANNER = /\.(php\d?|aspx?|jsp|cgi|env|ini|sql|bak|zip|gz|tar|ya?ml|log)($|\/)|\/(wp-|wordpress|\.git|\.aws|\.env|\.well-known\/|cgi-bin|phpmyadmin|vendor\/|xmlrpc)/i;
const isFunction = (p) => p.startsWith("/api/") || p.startsWith("/t/");

/** What, if anything, the site log should say about this answer. Pure, so tests can call it. */
export function logEntryFor(request, res, ms) {
  const url = new URL(request.url), p = url.pathname;
  if (p === "/api/log") return null;   // the log doesn't log itself
  const base = { path: p.slice(0, 200), device: device(request.headers.get("user-agent")), status: res.status, ms };
  if (isFunction(p)) {
    if (res.status >= 500) return alreadyReported(request) ? null : { ...base, kind: "function_error", message: `${request.method} ${p} answered ${res.status}` };
    if (ms >= SLOW_MS) return { ...base, kind: "slow", message: `${request.method} ${p} took ${(ms / 1000).toFixed(1)} s` };
    return null;
  }
  if (res.status === 404 && request.method === "GET" && (request.headers.get("accept") || "").includes("text/html") && !SCANNER.test(p)) {
    // Where the dead link was: a path when it's on TripVibz (a link to fix), else the other site's name.
    let source = null;
    try { const r = new URL(request.headers.get("referer") || ""); source = r.host === url.host ? r.pathname.slice(0, 120) : r.hostname.slice(0, 120); } catch { /* typed in, or hidden */ }
    return { ...base, kind: "not_found", source, ms: null };
  }
  return null;
}

/** context.next(), timed, with failures and missing pages sent to the site log. */
async function watched(context, started = Date.now()) {
  const { request, env } = context;
  const later = (entry) => { try { if (entry && context.waitUntil) context.waitUntil(record(env, request, entry)); } catch { /* never in the way */ } };
  let res;
  try { res = await context.next(); }
  catch (err) {
    const p = new URL(request.url).pathname;
    if (!alreadyReported(request)) later({ kind: "function_error", path: p.slice(0, 200), device: device(request.headers.get("user-agent")),
      message: `${request.method} ${p} threw: ${(err && err.message) || err}`.slice(0, 300), detail: err && err.stack ? String(err.stack).slice(0, 800) : null, ms: Date.now() - started });
    throw err;
  }
  try { later(logEntryFor(request, res, Date.now() - started)); } catch { /* never in the way */ }
  return res;
}

export async function onRequest(context, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { request } = context;
  const next = async () => withSecurityHeaders(await watched(context));
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
