/**
 * Phone notifications for James via ntfy (https://ntfy.sh, free app for iPhone
 * and Android). Cloudflare Pages env: NTFY_TOPIC (the private topic name James
 * subscribed to in the app). Without it nothing is sent.
 *
 * Nothing personal goes out: page paths, the take as posted (it's public
 * anyway), and the visitor's approximate city from Cloudflare. No IPs, no names.
 */
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
export function where(request) {
  const cf = request.cf || {};
  return [cf.city, cf.regionCode || cf.region, cf.country].filter(Boolean).join(", ");
}

/** A Function failure, pushed the same way as a browser error (never throws). */
export async function reportError(env, request, whereLabel, err) {
  const msg = err && (err.message || String(err)) || "unknown error";
  await notify(env, {
    title: `Function error: ${whereLabel}`,
    message: `${msg.slice(0, 300)}\n${new URL(request.url).pathname}${where(request) ? `\nVisitor near ${where(request)}` : ""}`,
    click: "https://www.tripvibz.com" + new URL(request.url).pathname,
    tags: "rotating_light",
    priority: 2
  });
}
