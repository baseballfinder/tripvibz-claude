/**
 * The site log: visits and errors, kept for 30 days in public.site_log so the
 * admin page can show them as they happen (supabase/migrations/20261117190000_site_log.sql).
 *
 *   visit           a visit started (first page of a browser tab's session)
 *   page            another page in the same visit
 *   leave           the visitor left a page (ms = time spent on it)
 *   error           a browser error raised by this site's own scripts
 *   request_failed  a save or request the browser made was refused or never answered
 *   function_error  a Function threw or answered 5xx
 *   slow            a Function took longer than SLOW_MS
 *   not_found       a page that doesn't exist was asked for
 *
 * Nothing personal: no IP, no account, no name. The session id is a random id
 * the browser keeps for one tab; place is Cloudflare's rough city.
 *
 * Fails open: the log is a nice-to-have. A write that is slow or refused is
 * dropped after STORE_TIMEOUT_MS and never reaches the visitor.
 */
import { SUPABASE_URL } from "../_config.js";
import { adminHeaders } from "./_supabase.js";

export const KINDS = ["visit", "page", "leave", "error", "request_failed", "function_error", "slow", "not_found"];
export const SLOW_MS = 3000;
const STORE_TIMEOUT_MS = 2000;

export const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime|monitor|python-requests|curl\/|wget\/|go-http-client/i;

/** phone / tablet / desktop / bot, from the browser's own description of itself. */
export function device(ua) {
  ua = String(ua || "");
  if (!ua || BOT.test(ua)) return "bot";
  if (/ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return "phone";
  return "desktop";
}

/** Rough "City, ST, US" from Cloudflare (same as the phone notifications use). */
export function placeOf(request) {
  const cf = (request && request.cf) || {};
  return [cf.city, cf.regionCode || cf.region, cf.country].filter(Boolean).join(", ");
}

const SEARCH = [[/(^|\.)google\./, "Google"], [/(^|\.)bing\.com$/, "Bing"], [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.com$/, "Yahoo"], [/(^|\.)ecosia\.org$/, "Ecosia"], [/(^|\.)brave\.com$/, "Brave"], [/(^|\.)perplexity\.ai$/, "Perplexity"],
  [/(^|\.)chatgpt\.com$/, "ChatGPT"]];
const SOCIAL = [[/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"], [/(^|\.)instagram\.com$/, "Instagram"], [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X"], [/(^|\.)reddit\.com$/, "Reddit"], [/(^|\.)pinterest\.[a-z.]+$/, "Pinterest"],
  [/(^|\.)(kit\.com|convertkit\.com|ck\.page|kit-mail\d*\.com)$/, "Kit email"]];

/**
 * Where a visit came from, in words: "Google · searched "miami in july"",
 * "Facebook", "Kit email (tv-miami-pilot)", "example.com", or "Direct".
 * ref = document.referrer; tag = utm_source / utm_campaign from the landing address.
 */
export function sourceOf(ref, tag, ownHost) {
  let host = "", q = "";
  try { const u = new URL(String(ref || "")); host = u.hostname.toLowerCase(); q = u.searchParams.get("q") || ""; } catch { /* no referrer */ }
  if (host && ownHost && (host === ownHost || host.endsWith(".tripvibz.pages.dev") || /(^|\.)tripvibz\.com$/.test(host))) host = "";
  const named = (SEARCH.find(([re]) => re.test(host)) || SOCIAL.find(([re]) => re.test(host)) || [])[1];
  const isSearch = SEARCH.some(([re]) => re.test(host));
  let out = named || host.replace(/^www\./, "") || "";
  if (isSearch && q) out += ` · searched "${q.slice(0, 60)}"`;
  tag = String(tag || "").replace(/[^\w .:/+-]/g, "").slice(0, 60);
  if (tag) out = out ? `${out} (${tag})` : tag;
  return (out || "Direct").slice(0, 120);
}

const str = (v, max) => { v = v == null ? "" : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim(); return v ? v.slice(0, max) : null; };
const int = (v, max) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null; };

/** One row for public.site_log, every field cut to what the table accepts; null if it isn't a log entry. */
export function clean(entry) {
  if (!entry || !KINDS.includes(entry.kind)) return null;
  const sid = typeof entry.session_id === "string" && /^[a-z0-9]{8,32}$/.test(entry.session_id) ? entry.session_id : null;
  const path = typeof entry.path === "string" && entry.path.startsWith("/") ? entry.path.slice(0, 200) : null;
  if (!path) return null;
  return {
    kind: entry.kind, session_id: sid, path,
    source: str(entry.source, 120), place: str(entry.place, 120),
    device: ["phone", "tablet", "desktop", "bot"].includes(entry.device) ? entry.device : null,
    message: str(entry.message, 300), detail: str(entry.detail, 800),
    status: int(entry.status, 999), ms: int(entry.ms, 86400000)
  };
}

/** Save one entry. Resolves true when stored, false when dropped; never throws. */
export async function store(env, entry, fetchImpl = fetch) {
  const row = clean(entry);
  if (!row || !env || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), STORE_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/site_log`, {
      method: "POST",
      headers: adminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { "content-type": "application/json", prefer: "return=minimal" }),
      body: JSON.stringify(row), signal: ctl.signal
    });
    return r.ok;
  } catch { return false; }   // Supabase slow or down, table not there yet: the visitor never notices
  finally { clearTimeout(t); }
}
