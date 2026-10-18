/**
 * GET /t/<take id> — the link people share for a single take.
 *
 * Serves the normal thread page, but with the take itself in the link preview:
 * Facebook, iMessage and X don't run JavaScript, so without this every shared
 * take would preview as a generic page. Title = the take, image = that city's
 * "A <City> local says…" card (assets/og/<slug>-take.jpg).
 *
 * Read-only: uses the public key and only reads posts and cities.
 */
const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const SITE = "https://www.tripvibz.com";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function read(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

export async function onRequestGet({ params, request, env }) {
  const page = await env.ASSETS.fetch(new URL("/thread", request.url));
  const id = String(params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return page;

  let post = null, city = null;
  try {
    post = await read(`posts?select=title,ups,downs,city_id&id=eq.${id}`);
    if (post) city = await read(`cities?select=name,slug&id=eq.${post.city_id}`);
  } catch (e) { /* fall back to the plain page */ }
  if (!post || !city) return page;

  const title = `“${post.title}” — a ${city.name} local`;
  const votes = post.ups + post.downs;
  const desc = votes
    ? `${post.ups} local${post.ups === 1 ? "" : "s"} say true, ${post.downs} say nope. What do you think?`
    : "Is this true, or nope? Locals are voting on TripVibz.";
  const image = `${SITE}/assets/og/${city.slug}-take.jpg`;
  const url = `${SITE}/t/${id}`;
  const tags = `
<meta property="og:type" content="article">
<meta property="og:site_name" content="TripVibz">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/jpeg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">`;

  const out = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(`${title} · TripVibz`); } })
    .on("head", { element(el) { el.append(tags, { html: true }); } })
    .transform(page);
  const headers = new Headers(out.headers);
  headers.set("cache-control", "public, max-age=300");
  return new Response(out.body, { status: 200, headers });
}
