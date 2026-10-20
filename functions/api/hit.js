/**
 * POST /api/hit — a visit that arrived from a search engine (sent once per
 * visit by assets/analytics.js). Pushes a phone notification; stores nothing.
 */
import { notify, where } from "./_notify.js";

const ENGINES = [[/(^|\.)google\./, "Google"], [/(^|\.)bing\.com$/, "Bing"], [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.com$/, "Yahoo"], [/(^|\.)ecosia\.org$/, "Ecosia"], [/(^|\.)brave\.com$/, "Brave"], [/(^|\.)perplexity\.ai$/, "Perplexity"],
  [/(^|\.)chatgpt\.com$/, "ChatGPT"]];
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless/i;

export async function onRequestPost(context) {
  const { request, env } = context;
  let d = {};
  try { d = await request.json(); } catch {}
  const ua = request.headers.get("user-agent") || "";
  let host = "";
  try { host = new URL(String(d.ref || "")).hostname; } catch {}
  const engine = (ENGINES.find(([rx]) => rx.test(host)) || [])[1];
  const path = typeof d.path === "string" && d.path.startsWith("/") ? d.path.slice(0, 200) : "";
  if (!engine || !path || BOT.test(ua)) return new Response(null, { status: 204 });
  let q = "";
  try { q = new URL(String(d.ref)).searchParams.get("q") || ""; } catch {}   // Google hides it; Bing/DDG sometimes don't
  const place = where(request);
  context.waitUntil(notify(env, {
    title: `Search visit from ${engine}`,
    message: `${path}${q ? `\nSearched: "${q.slice(0, 120)}"` : ""}${place ? `\nVisitor near ${place}` : ""}`,
    click: "https://www.tripvibz.com" + path,
    tags: "mag",
    priority: 2
  }));
  return new Response(null, { status: 204 });
}
