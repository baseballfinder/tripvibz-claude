/**
 * POST /api/error — a browser-side error (assets/analytics.js sends
 * window.onerror / unhandledrejection) or a Function failure, pushed to
 * James's phone via ntfy so a broken page is noticed before a visitor
 * complains. Stores nothing.
 *
 * Abuse limits: body ≤ 2 KB, only errors raised by this site's own scripts
 * (a stack mentioning our origin) or by Functions, priority low, and the
 * page de-duplicates and caps itself to 3 reports per page view.
 */
import { notify, where } from "./_notify.js";

const OWN = /(^|\/\/)(www\.)?tripvibz\.com\/|tripvibz\.pages\.dev\/|\/assets\//;

export async function onRequestPost(context) {
  const { request, env } = context;
  let d = {};
  try { d = JSON.parse((await request.text()).slice(0, 2048)); } catch { return new Response(null, { status: 204 }); }
  const message = String(d.message || "").slice(0, 300);
  const stack = String(d.stack || "").slice(0, 600);
  const source = String(d.source || "").slice(0, 200);
  const page = typeof d.page === "string" && d.page.startsWith("/") ? d.page.slice(0, 200) : "";
  if (!message || !page) return new Response(null, { status: 204 });
  // Browser extensions, injected ads and other sites' scripts throw too; only ours count.
  if (!OWN.test(stack) && !OWN.test(source)) return new Response(null, { status: 204 });
  const place = where(request);
  context.waitUntil(notify(env, {
    title: `Site error on ${page}`,
    message: `${message}${source ? `\n${source}` : ""}${stack ? `\n${stack.split("\n").slice(0, 3).join("\n")}` : ""}${place ? `\nVisitor near ${place}` : ""}`,
    click: "https://www.tripvibz.com" + page,
    tags: "rotating_light",
    priority: 2
  }));
  return new Response(null, { status: 204 });
}
