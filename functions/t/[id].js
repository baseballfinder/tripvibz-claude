/**
 * GET /t/<take id> — the link people share for a single take.
 *
 * Serves the normal thread page, but with the take itself in the link preview:
 * Facebook, iMessage and X don't run JavaScript, so without this every shared
 * take would preview as a generic page. Title = the take, image = that city's
 * "A <City> local says…" card (assets/og/<slug>-take.jpg).
 *
 * Search: the page also gets the take as plain HTML (the thread page draws
 * itself with JavaScript, so crawlers otherwise see "Loading…") and
 * DiscussionForumPosting structured data, Google's type for user posts.
 * One-line takes with no replies are noindex: too thin to rank on their own,
 * and they already appear on the city's theme page.
 *
 * Read-only: uses the public key and only reads posts, comments and cities.
 */
const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const SITE = "https://www.tripvibz.com";
import { withSecurityHeaders } from "../_security.js";
import { reportError } from "../api/_notify.js";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function rows(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`supabase ${r.status}`);   // an outage is not "not found"
  return r.json();
}
const read = async path => (await rows(path))[0] || null;

const THEME = { what_not_to_do: "what-not-to-do", worst_times: "worst-times-to-visit", hidden_gem: "what-locals-do" };
const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const plain = s => String(s || "").replace(/\s+/g, " ").trim();

export async function onRequestGet(context) {
  try { return await takePage(context); }
  catch (e) {
    context.waitUntil?.(reportError(context.env, context.request, "/t/<id>", e));
    // Serve the plain page (it loads the take itself) rather than a 500.
    return withSecurityHeaders(await context.env.ASSETS.fetch(new URL("/thread", context.request.url)));
  }
}

async function takePage({ params, request, env }) {
  const page = await env.ASSETS.fetch(new URL("/thread", request.url));
  const id = String(params.id || "");
  // A real 404 for bad or removed takes, so Google drops them instead of
  // indexing an empty page (hidden takes aren't readable with the public key).
  const notFound = async () => {
    const nf = await env.ASSETS.fetch(new URL("/404.html", request.url));
    return withSecurityHeaders(new Response(nf.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }));
  };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();

  let post = null, city = null;
  try {
    post = await read(`posts?select=title,body,type,ups,downs,city_id,created_at,author_id,author_verified&id=eq.${id}`);
    if (!post) return notFound();
    city = await read(`cities?select=name,state,slug&id=eq.${post.city_id}`);
  } catch (e) { return withSecurityHeaders(page); /* database hiccup: serve the page, which loads it itself */ }
  if (!city) return withSecurityHeaders(page);

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

  let comments = [];
  try {
    comments = await rows(`comments?select=body,created_at,author_id,author_verified&post_id=eq.${id}&order=created_at.asc&limit=50`);
  } catch (e) { /* page still works without them */ }

  // Verified ✓ for this city (presence over time; /how-we-verify-locals/). Public columns only.
  const verifiedHere = new Set();
  try {
    const ids = [post.author_id, ...comments.map(c => c.author_id)].filter(Boolean);
    if (ids.length) for (const r of await rows(`local_checks?select=user_id,verified,revoked&city_id=eq.${post.city_id}&user_id=in.(${[...new Set(ids)].join(",")})`))
      if (r.verified && !r.revoked) verifiedHere.add(r.user_id);
  } catch (e) { /* label falls back to "unverified" */ }
  // Same three tiers the page script draws (assets/v2.js localBadge).
  const local = (signedIn, authorId) => !signedIn ? "Anonymous"
    : verifiedHere.has(authorId) ? `Verified ${city.name} local` : `${city.name} local (unverified)`;
  // Answers to a city question store the question in body as "On: <question>".
  const onQ = /^On:\s*/i.test(plain(post.body)) ? plain(post.body).replace(/^On:\s*/i, "") : "";
  const extra = onQ ? "" : plain(post.body);
  const text = [plain(post.title), extra].filter(Boolean).join(" ");
  const thin = !comments.length && text.length < 80;
  const theme = THEME[post.type];
  const posting = {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "DiscussionForumPosting",
      "@id": `${url}#take`,
      url,
      mainEntityOfPage: url,
      headline: (onQ || plain(post.title)).slice(0, 110),
      text,
      inLanguage: "en-US",
      datePublished: post.created_at,
      author: { "@type": "Person", name: local(post.author_verified, post.author_id) },
      about: { "@type": "Place", name: city.name + (city.state ? ", " + city.state : "") },
      isPartOf: theme ? `${SITE}/${city.slug}/${theme}/` : `${SITE}/${city.slug}/`,
      interactionStatistic: [
        { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: post.ups },
        { "@type": "InteractionCounter", interactionType: "https://schema.org/DislikeAction", userInteractionCount: post.downs },
        { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: comments.length }
      ],
      // Only when there are replies: an empty comment array is invalid noise to validators.
      ...(comments.some(c => plain(c.body)) ? { comment: comments.filter(c => plain(c.body)).map(c => ({
        "@type": "Comment",
        text: plain(c.body),
        datePublished: c.created_at,
        author: { "@type": "Person", name: local(c.author_verified, c.author_id) }
      })) } : {})
    }, {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "TripVibz", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: city.name, item: `${SITE}/${city.slug}/` },
        { "@type": "ListItem", position: 3, name: plain(post.title).slice(0, 80), item: url }
      ]
    }]
  };
  // What a crawler reads before the page script takes over the same spot.
  const body = `<article class="take"><a class="back" href="/${esc(city.slug)}/">← ${esc(city.name)}</a>
${onQ ? `<div class="kicker">${esc(onQ)}</div>` : ""}<h1>${esc(post.title)}</h1>${extra ? `<p>${esc(extra)}</p>` : ""}
<div class="who">${local(post.author_verified, post.author_id)} · ${post.ups} true · ${post.downs} nope</div>
${comments.map(c => plain(c.body) ? `<p class="reply"><b>${local(c.author_verified, c.author_id)}:</b> ${esc(c.body)}</p>` : "").join("")}
</article>`;
  const head = tags + ld(posting) + (thin ? `\n<meta name="robots" content="noindex,follow">` : "");

  const out = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(`${title} · TripVibz`); } })
    .on("head", { element(el) { el.append(head, { html: true }); } })
    .on("main#root", { element(el) { el.setInnerContent(body, { html: true }); } })
    .transform(page);
  const headers = new Headers(out.headers);
  headers.set("cache-control", "public, max-age=300");
  return withSecurityHeaders(new Response(out.body, { status: 200, headers }));
}
