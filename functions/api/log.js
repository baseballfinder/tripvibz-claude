/**
 * POST /api/log — what a visitor's browser reports (assets/analytics.js):
 *
 *   { k: "page",  sid, path, first, ref, tag }     a page opened; first = the visit's first page
 *   { k: "leave", sid, path, ms, rec }             left the page after ms; rec = the visit's Clarity recording ids
 *   { k: "error", sid, path, msg, src, stack }     a script error
 *   { k: "request_failed", sid, path, target, status, msg }   a save or request was refused or unanswered
 *
 * Each becomes a row in the site log (./_log.js) and, for visits and errors, a
 * phone notification (./_notify.js). Always answers 204 with nothing in it.
 *
 * Abuse limits: body ≤ 2 KB, every field cut to a fixed length, posts from
 * another site's pages and from bots dropped, errors only when raised by this
 * site's own scripts, and the page caps itself (3 errors and 5 failed requests
 * per page view, one visit per tab).
 */
import { device, sourceOf, BOT } from "./_log.js";
import { record } from "./_notify.js";

const OWN = /(^|\/\/)(www\.)?tripvibz\.com\/|tripvibz\.pages\.dev\/|\/assets\//;
const done = () => new Response(null, { status: 204 });
// Where a visit's Clarity recording plays (xpi9uwoqof = TripVibz's Clarity project, the id assets/analytics.js loads).
export const CLARITY_PLAYER = "https://clarity.microsoft.com/player/xpi9uwoqof/";

export async function onRequestPost(context) {
  const { request, env } = context;
  const ua = request.headers.get("user-agent") || "";
  if (BOT.test(ua)) return done();
  const self = new URL(request.url);
  // A browser says which page posted. Another site's page has no business here.
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== self.host) return done(); } catch { return done(); } }

  let d = {};
  try { d = JSON.parse((await request.text()).slice(0, 2048)); } catch { return done(); }
  if (!d || typeof d !== "object") return done();
  const path = typeof d.path === "string" && d.path.startsWith("/") && !d.path.startsWith("//") ? d.path.slice(0, 200) : "";
  if (!path) return done();
  const base = { session_id: d.sid, path, device: device(ua) };

  let entry = null;
  if (d.k === "page") {
    entry = d.first ? { ...base, kind: "visit", source: sourceOf(d.ref, d.tag, self.hostname) } : { ...base, kind: "page" };
  } else if (d.k === "leave") {
    // rec = "<Clarity visitor id>/<Clarity session id>" from Clarity's own cookies: the visit's recording.
    const rec = typeof d.rec === "string" && /^[a-z0-9]{3,16}\/[a-z0-9]{3,16}$/.test(d.rec) ? CLARITY_PLAYER + d.rec : null;
    entry = { ...base, kind: "leave", ms: d.ms, detail: rec };
  } else if (d.k === "error") {
    const message = String(d.msg || "").slice(0, 300), stack = String(d.stack || "").slice(0, 600), src = String(d.src || "").slice(0, 200);
    // Browser extensions, injected ads and other sites' scripts throw too; only ours count.
    if (!message || (!OWN.test(stack) && !OWN.test(src))) return done();
    entry = { ...base, kind: "error", message, detail: [src, stack].filter(Boolean).join("\n") };
  } else if (d.k === "request_failed") {
    const target = String(d.target || "").slice(0, 160);
    if (!/^[A-Z]{3,7} [\w./:-]+$/.test(target)) return done();   // "POST question_votes", "POST /api/take"
    entry = { ...base, kind: "request_failed", detail: target, status: d.status, message: String(d.msg || "").slice(0, 300) };
  }
  if (!entry) return done();
  context.waitUntil(record(env, request, entry));
  return done();
}
