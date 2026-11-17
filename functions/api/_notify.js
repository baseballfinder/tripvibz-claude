/**
 * Phone notifications for James via ntfy (https://ntfy.sh, free app for iPhone
 * and Android). Cloudflare Pages env: NTFY_TOPIC (the private topic name James
 * subscribed to in the app). Without it nothing is sent.
 *
 * Nothing personal goes out: page paths, the take as posted (it's public
 * anyway), and the visitor's approximate city from Cloudflare. No IPs, no names.
 *
 * record() below is the one door for visits and errors: it saves the entry to
 * the site log (./_log.js, shown live on the admin page) and pushes the kinds
 * pushFor() picks.
 */
import { store, placeOf } from "./_log.js";

export async function notify(env, { title, message, click, tags, priority }) {
  if (!env || !env.NTFY_TOPIC) return;
  try {
    await fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), {
      method: "POST",
      headers: {
        "Title": encodeHeader(title || "TripVibz"),
        "Tags": tags || "",
        "Priority": String(priority || 3),
        ...(click ? { "Click": click } : {})
      },
      body: String(message || "").slice(0, 1000)
    });
  } catch (e) { /* a failed notification never breaks the request */ }
}
// HTTP headers must be plain ASCII; ntfy decodes RFC 2047 for anything else.
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode(s))) + "?=";
}
export const where = placeOf;

const SITE = "https://www.tripvibz.com";
const DEVICE = { phone: "Phone", tablet: "Tablet", desktop: "Computer", bot: "Bot" };

/** The phone notification for a log entry, or null when that kind is only stored. */
export function pushFor(e) {
  const near = e.place ? `\n${DEVICE[e.device] || "Visitor"} near ${e.place}` : (DEVICE[e.device] ? `\n${DEVICE[e.device]}` : "");
  const click = SITE + (e.path || "/");
  switch (e.kind) {
    case "visit":
      return e.device === "bot" ? null
        : { title: `New visit: ${e.path}`, message: `From ${e.source || "Direct"}${near}`, click, tags: "eyes", priority: 2 };
    case "error":
      return { title: `Site error on ${e.path}`, message: `${e.message || ""}${e.detail ? `\n${e.detail.split("\n").slice(0, 4).join("\n")}` : ""}${near}`, click, tags: "rotating_light", priority: 2 };
    case "request_failed":
      return { title: `Save or request failed on ${e.path}`, message: `${e.detail || ""}${e.status ? ` answered ${e.status}` : " got no answer"}${e.message ? `\n${e.message}` : ""}${near}`, click, tags: "warning", priority: 2 };
    case "function_error":
      return { title: `Function error: ${e.path}`, message: `${e.message || "unknown error"}${e.status ? ` (${e.status})` : ""}${near}`, click, tags: "rotating_light", priority: 3 };
    case "not_found":
      // Only a broken link on TripVibz itself is worth a buzz; strangers guessing addresses are just stored.
      return e.source && e.source.startsWith("/") && e.device !== "bot"
        ? { title: `Broken link: ${e.path}`, message: `Linked from ${e.source}${near}`, click: SITE + e.source, tags: "link", priority: 2 } : null;
    default:
      return null;   // page, leave, slow: in the admin log only
  }
}

/** Requests whose failure a Function already reported, so the site-wide watcher doesn't log it twice. */
const reported = new WeakSet();
export const alreadyReported = (request) => reported.has(request);

/**
 * Log one thing that happened: stored for the admin page and, for the kinds
 * worth interrupting James, pushed to his phone. Never throws.
 */
export async function record(env, request, entry) {
  try {
    const e = { place: placeOf(request), ...entry };
    await Promise.all([store(env, e), (p => p ? notify(env, p) : null)(pushFor(e))]);
  } catch { /* the log never breaks the request */ }
}

/** A Function failure a Function caught itself: logged and pushed like any other error (never throws). */
export async function reportError(env, request, whereLabel, err) {
  const msg = err && (err.message || String(err)) || "unknown error";
  try { reported.add(request); } catch { /* not an object in a test */ }
  let path = whereLabel;
  try { path = new URL(request.url).pathname; } catch { /* keep the label */ }
  await record(env, request, { kind: "function_error", path, message: `${whereLabel}: ${msg}`.slice(0, 300), detail: err && err.stack ? String(err.stack).slice(0, 800) : null });
}
