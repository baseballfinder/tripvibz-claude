/* ==========================================================================
   TripVibz build

   Two jobs:
     1. Minify JS/CSS (including the inline blocks in each page).
     2. PRE-RENDER. Pull content from Supabase and write real HTML at real
        paths, so crawlers get the article text instead of "Loading…".

   Why pre-rendering matters here: every page fetches its content client-side.
   Before this, article.html shipped 45 characters of static text and the whole
   site was 6 URLs behind query strings — which Google collapses into one
   document per file. Pre-rendering turns that into ~70 indexable pages.

   The client script still runs and re-renders the same content into #root,
   so voting and contributing keep working. The static markup is what the
   crawler indexes; the hydrated version is what the user interacts with.

   This is a size/SEO step. It is not a security boundary — everything here
   still ships to the browser.
   ========================================================================== */

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { createHash } from "node:crypto";

// Dynamic so a missing dependency produces an instruction rather than a
// module-resolution stack trace.
let transform, bundle;
try {
  ({ transform, build: bundle } = await import("esbuild"));
} catch {
  console.error("\n  esbuild isn't installed.\n");
  console.error("  Run this first:\n");
  console.error("      npm install\n");
  process.exit(1);
}

const SRC = ".";
const OUT = "dist";
// www is the host Cloudflare actually serves; the apex redirects to it.
// Canonicals must name the served host or Google indexes a redirect.
// The apex (tripvibz.com) does not serve this site (it 404s), so a SITE_URL
// pointing at it would send Facebook's crawler and Google to a dead host via
// og:url, og:image and canonicals. Force www for the apex.
const SITE = (process.env.SITE_URL || "https://www.tripvibz.com").replace(/\/$/, "")
  .replace(/^https?:\/\/tripvibz\.com$/, "https://www.tripvibz.com");

const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

// "functions" stays out: Cloudflare Pages compiles it from the project root,
// so copying it into the output would upload the handler as a static asset.
const SKIP = new Set([
  "dist", "node_modules", ".git", "supabase", ".github", "functions",
  "build.mjs", "package.json", "package-lock.json", "lighthouserc.json",
  // Maintenance scripts and docs are not site content; never publish them.
  "scripts", "data", "tests", "README.md", "vote.html", "add.html"
]);

const THEMES = {
  what_not_to_do: {
    slug: "what-not-to-do",
    nav: "What not to do",
    chip: "What not to do",
    title: c => `What not to do in ${c}`,
    lede: c => `The mistakes visitors make in ${c}, according to people who live there. Ranked by how many locals say it's true.`,
    desc: c => `Local advice on what not to do in ${c} — the mistakes visitors make, written and ranked by people who live there.`
  },
  worst_times: {
    slug: "worst-times-to-visit",
    nav: "Worst times to visit",
    chip: "Worst times",
    title: c => `Worst times to visit ${c}`,
    lede: c => `The weeks, days and hours locals would tell you to avoid in ${c} — and what to do instead.`,
    desc: c => `The worst times to visit ${c}, month by month — festivals, seasons and weeks locals say to avoid.`
  },
  hidden_gem: {
    slug: "what-locals-do",
    nav: "What locals actually do",
    chip: "What locals do",
    title: c => `What locals actually do in ${c}`,
    lede: c => `The parts of ${c} that don't show up on the top-ten lists, from people who never left.`,
    desc: c => `What locals actually do in ${c} — the spots and habits that never make the top-ten lists.`
  }
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const bytes = n => (n / 1024).toFixed(1) + "kb";
const report = [];
const pages = [];   // { path, lastmod, priority } for the sitemap

/* ---------------- data ---------------- */

async function fetchTable(name, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${name}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadContent() {
  try {
    const [cities, posts, events] = await Promise.all([
      fetchTable("cities", "select=id,name,state,slug,photo,lat,lng&order=sort"),
      fetchTable("posts", "select=id,title,body,type,ups,downs,created_at,city_id"),
      fetchTable("city_events", "select=id,name,blurb,kind,severity,start_month,end_month,city_id")
    ]);
    return { cities, posts, events };
  } catch (err) {
    // Offline fallback for local development only. It is gitignored, so CI
    // and Cloudflare always build from live data — a stale snapshot must
    // never be what ships.
    try {
      const fixture = JSON.parse(await readFile("content.fixture.json", "utf8"));
      console.warn("\n  !! Supabase unreachable — building from content.fixture.json");
      console.warn("  !! LOCAL PREVIEW ONLY. Never deploy this output.\n");
      return fixture;
    } catch {
      console.error("\n  Supabase unreachable and no local fixture present.");
      throw err;
    }
  }
}

/* ---------------- page shell ---------------- */

const MONTHS = ["January","February","March","April","May","June","July",
                "August","September","October","November","December"];

function head({ title, desc, canonical, image, noindex, og = {} }) {
  const ogTitle = og.title || title, ogDesc = og.desc || desc;
  return `<title>${esc(title)}</title>
${noindex ? `<meta name="robots" content="noindex,follow" />` : ""}
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="TripVibz" />
<meta property="og:title" content="${esc(ogTitle)}" />
<meta property="og:description" content="${esc(ogDesc)}" />
<meta property="og:url" content="${esc(canonical)}" />
${image ? `<meta property="og:image" content="${esc(image)}" />` : ""}
${og.card ? `<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:image:alt" content="${esc(ogTitle)}" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(ogTitle)}" />
<meta name="twitter:description" content="${esc(ogDesc)}" />
${image ? `<meta name="twitter:image" content="${esc(image)}" />` : ""}`;
}

// Find <div id="X"> and replace its contents, walking nested divs to find the
// matching close. Regex alone can't do this reliably for mounts that already
// contain markup.
function injectInto(html, id, content) {
  const open = new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`);
  const m = open.exec(html);
  if (!m) throw new Error(`injectInto: no #${id}`);

  const start = m.index + m[0].length;
  let depth = 1, i = start;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let t;
  while ((t = tag.exec(html))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) { i = t.index; break; }
  }
  return html.slice(0, start) + content + html.slice(i);
}

// Replace the shell's <title> and inject metadata + pre-rendered body.
// The shell's own description is stripped FIRST, so it can't delete the one
// we then inject (that ordering bug shipped pages with no description).
function render(template, { title, desc, canonical, image, body, mount = "root", jsonLd, noindex, og }) {
  let out = template.replace(/<meta name="description"[^>]*>\s*/g, "");
  const headOut = head({ title, desc, canonical, image, noindex, og });
  out = out.replace(/<title>[\s\S]*?<\/title>/, () => headOut);
  if (jsonLd) out = out.replace(/<\/head>/, () => jsonLd + "</head>");
  if (body) out = injectInto(out, mount, body);
  return out;
}

// Resolves a city's og:image. PHOTO_BY_SLUG is filled after content loads;
// falls back to {slug}.webp for cities with no explicit photo filename.
const PHOTO_BY_SLUG = {};

// Social share cards (scripts/og_cards.py): a 1200x630 JPEG with the city's
// hook question over its photo. Facebook shows og:title in bold, so for share
// previews the title is the question itself, aimed at locals.
let OG_CARDS = {};
try { OG_CARDS = JSON.parse(await readFile("assets/og/cards.json", "utf8")); } catch {}
const ogCard = (file, title, desc) => ({ card: true, image: `${SITE}/assets/og/${file}`, title, desc });
const shareCard = city => {
  const c = OG_CARDS[city.slug];
  if (!c) return null;
  return {
    card: true,
    image: `${SITE}/assets/og/${city.slug}.jpg`,
    title: `${c.prompt} (${city.name} locals vote)`,
    desc: "One tap to vote, then see how many locals agree with you. Plus what tourists keep getting wrong."
  };
};
const photo = slug => `${SUPABASE_URL}/storage/v1/object/public/city-photos/` +
  encodeURIComponent(PHOTO_BY_SLUG[slug] || `${slug}.webp`);

/* ---------------- structured data (JSON-LD) ----------------
   Article + BreadcrumbList + ItemList on theme pages, BreadcrumbList on city
   pages, Organization + WebSite on the home page. Google-supported types only.

   Deliberately NOT emitting Event markup for the calendar: Google's Event
   structured data requires a concrete startDate, and our events are recurring,
   month-level (Fantasy Fest "late October", no year/day). Fabricating dates
   risks a Search Console manual action, so the calendar stays as on-page HTML
   until we track confirmed per-year dates. */

const ORG = {
  "@type": "Organization",
  "@id": `${SITE}/#org`,
  name: "TripVibz",
  url: `${SITE}/`,
  logo: `${SITE}/assets/brand/icon-512.png`,
  description: "Local guides to what visitors get wrong, when not to come, and what residents actually do.",
  sameAs: []
};

function ld(obj) {
  // JSON in a script tag: escape </ so a "</script>" in data can't break out.
  return `<script type="application/ld+json">` +
    JSON.stringify(obj).replace(/</g, "\\u003c") +
    `</script>`;
}

function homeLd() {
  return ld({
    "@context": "https://schema.org",
    "@graph": [
      ORG,
      {
        "@type": "WebSite",
        "@id": `${SITE}/#website`,
        url: `${SITE}/`,
        name: "TripVibz",
        publisher: { "@id": `${SITE}/#org` },
        inLanguage: "en-US"
      }
    ]
  });
}

function breadcrumbLd(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url
    }))
  };
}

function cityLd(city, url, takes = []) {
  const graph = [
    breadcrumbLd([
      { name: "TripVibz", url: `${SITE}/` },
      { name: "Cities", url: `${SITE}/cities/` },
      { name: city.name, url }
    ])
  ];
  // Populated city pages: the ranked takes as an ItemList (same order as the page).
  const ranked = takes.slice().sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs));
  if (ranked.length) {
    graph.push({
      "@type": "ItemList",
      "@id": `${url}#takes`,
      name: `What locals say about ${city.name}`,
      numberOfItems: ranked.length,
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      itemListElement: ranked.map((t, i) => ({
        "@type": "ListItem", position: i + 1, name: t.title, url: `${SITE}/t/${t.id}`
      }))
    });
  }
  return ld({ "@context": "https://schema.org", "@graph": graph });
}

function articleLd(city, theme, takes, url, cfg, image) {
  const dates = takes.map(t => t.created_at).filter(Boolean).sort();
  const published = dates[0] || new Date().toISOString();
  const modified = dates[dates.length - 1] || published;

  const graph = [
    {
      "@type": "Article",
      "@id": `${url}#article`,
      headline: cfg.title(city.name),
      description: cfg.desc(city.name),
      mainEntityOfPage: url,
      inLanguage: "en-US",
      datePublished: published,
      dateModified: modified,
      image: image ? [image] : undefined,
      author: { "@id": `${SITE}/#org` },
      publisher: { "@id": `${SITE}/#org` },
      about: { "@type": "Place", name: `${city.name}${city.state ? ", " + city.state : ""}` }
    },
    breadcrumbLd([
      { name: "TripVibz", url: `${SITE}/` },
      { name: city.name, url: `${SITE}/${city.slug}/` },
      { name: cfg.nav, url }
    ])
  ];

  // The ranked contributions as an ItemList — the substance of the page.
  const ranked = takes.slice()
    .sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs) ||
                    new Date(a.created_at) - new Date(b.created_at));
  if (ranked.length) {
    graph.push({
      "@type": "ItemList",
      "@id": `${url}#takes`,
      name: cfg.title(city.name),
      numberOfItems: ranked.length,
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      itemListElement: ranked.map((t, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: t.title,
        url: `${SITE}/t/${t.id}`
      }))
    });
  }

  return ld({ "@context": "https://schema.org", "@graph": graph });
}

/* ---------------- article body ---------------- */

function articleBody(city, theme, takes, events) {
  const t = THEMES[theme];
  const list = takes
    .slice()
    .sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs) ||
                    new Date(a.created_at) - new Date(b.created_at));

  const entries = list.length
    ? `<ol class="entries">${list.map(p => `<li class="entry"><a class="t" href="/t/${esc(p.id)}">${esc(p.title)}</a>${
        p.body ? `<div class="more">${esc(p.body)}</div>` : ""
      }<div class="foot"><span class="who">${p.ups} say true</span></div></li>`).join("")}</ol>`
    : `<div class="empty-article"><b>Live in ${esc(city.name)}? What do tourists get wrong?</b>
       <p>Say it here and visitors will actually read it. One sentence is enough.</p>
       <a class="btn coral" href="/${esc(city.slug)}/add/?kind=${theme}">Add your take</a></div>`;

  const cal = theme === "worst_times" && events.length
    ? `<section class="cal"><h2>${esc(city.name)} month by month</h2><p class="sub">Festivals, conventions, weather and price seasons that change what a visit is like. Researched by the TripVibz editors from official event and weather sources.</p>${
        MONTHS.map((m, i) => {
          const inM = events.filter(e => e.start_month <= e.end_month
            ? (i + 1 >= e.start_month && i + 1 <= e.end_month)
            : (i + 1 >= e.start_month || i + 1 <= e.end_month));
          if (!inM.length) return "";
          return `<div class="ev"><h3>${m}</h3>${inM.map(e =>
            `<p><b>${esc(e.name)}</b> — ${esc(e.severity)}${e.blurb ? `. ${esc(e.blurb)}` : ""}</p>`).join("")}</div>`;
        }).join("")
      }</section>`
    : "";

  return `<a class="back" href="/${esc(city.slug)}/">← ${esc(city.name)}</a>
<div class="hd">
  <div class="kicker">${esc(city.name)}${city.state ? ", " + esc(city.state) : ""}</div>
  <h1>${esc(t.title(city.name))}</h1>
  <p class="lede">${esc(t.lede(city.name))}</p>
  <div class="by">${list.length} take${list.length === 1 ? "" : "s"}</div>
</div>
<nav class="chips" aria-label="Show"><a class="chip" href="/${esc(city.slug)}/" aria-pressed="false">Everything</a>${Object.keys(THEMES).map(k =>
  `<a class="chip" href="/${esc(city.slug)}/${THEMES[k].slug}/" aria-pressed="${k === theme}">${esc(THEMES[k].chip)}</a>`).join("")}</nav>
${entries}
${cal}`;
}

// Without these, every city and article page is orphaned: the home page and
// city index build their grids in JS, so a crawler following links finds
// nothing beyond the two shells. Pre-render real <a> tags.
function cityGrid(cities, countsBySlug) {
  return cities.map(c => {
    const n = countsBySlug[c.slug] || 0;
    return `<a class="need" href="/${esc(c.slug)}/what-not-to-do/">
      <span class="txt"><b>${esc(c.name)}</b>
      <span class="s">${esc(c.state || "")}</span>
      <span class="n">${n ? `${n} take${n === 1 ? "" : "s"}` : "Be the first"}</span></span></a>`;
  }).join("");
}

function cityList(cities, countsBySlug) {
  return cities.map(c => {
    const n = countsBySlug[c.slug] || 0;
    return `<a class="city-card" href="/${esc(c.slug)}/">
      <div class="city-body"><h3>${esc(c.name)}</h3>
      <p>${esc(c.state || "")}</p>
      <div class="city-foot">${n ? `${n} local take${n === 1 ? "" : "s"}` : "Needs locals"}</div>
      </div></a>`;
  }).join("");
}

/* ---------------- editorial intros + nearby cities ----------------
   Empty city pages get a short intro clearly labeled as written by the
   TripVibz editors (never presented as a local's take). Sources are kept in
   the growth log, not on the page. Shown until the city has 3+ takes. */
const INTRO_MIN_TAKES = 3;
// Trim to a whole word under n characters for meta descriptions.
function clip(text, n) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, "") + "…";
}
function editorsHtml(city, intro) {
  if (!intro) return "";
  return `<section class="editors" id="tv-editors" aria-label="From the TripVibz editors">
<div class="editors-k">From the TripVibz editors</div>
<p>${esc(intro)}</p>
<div class="editors-note">Written by TripVibz, not by locals. Live in ${esc(city.name)}? <a href="/${esc(city.slug)}/add/">Add your take</a> and tell visitors what we missed.</div>
</section>`;
}

const toRad = d => d * Math.PI / 180;
function miles(a, b) {
  if (a.lat == null || b.lat == null) return Infinity;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}
// Same state first, then by distance. Internal links so no city page is a dead end.
function nearbyCities(city, cities, n = 4) {
  return cities.filter(c => c.slug !== city.slug)
    .map(c => ({ c, same: c.state && c.state === city.state ? 0 : 1, d: miles(city, c) }))
    .sort((x, y) => x.same - y.same || x.d - y.d)
    .slice(0, n).map(x => x.c);
}
function nearbyHtml(list) {
  if (!list.length) return "";
  return `<nav class="nearby" id="tv-nearby" aria-label="Nearby on TripVibz"><h2>Nearby on TripVibz</h2><div class="nearby-list">${
    list.map(c => `<a href="/${esc(c.slug)}/">${esc(c.name)}${c.state ? `<span>${esc(c.state)}</span>` : ""}</a>`).join("")
  }</div></nav>`;
}

// Crawler-readable version of the city feed; the page script replaces it
// (keeping the editors' intro and nearby links, see city.html).
function cityBody(city, counts, takes, intro = "", nearby = []) {
  const ranked = takes.slice().sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs));
  return `<a class="back" href="/cities/">← All cities</a>
<div class="kicker">${esc(city.name)}${city.state ? ", " + esc(city.state) : ""}</div>
<h1>What locals say about ${esc(city.name)}</h1>
<nav class="chips">${Object.keys(THEMES).map(k =>
    `<a class="chip" href="/${esc(city.slug)}/${THEMES[k].slug}/">${esc(THEMES[k].nav)}${counts[k] ? ` (${counts[k]})` : ""}</a>`).join("")}</nav>
<div class="feed">${ranked.length ? ranked.map(p => `<article class="take"><a class="tt" href="/t/${esc(p.id)}">${esc(p.title)}</a>${
    p.body ? `<div class="more">${esc(p.body)}</div>` : ""}<div class="who">${p.ups} true · ${p.downs} nope</div></article>`).join("")
  : `<div class="empty2"><b>No takes here yet</b>Live in ${esc(city.name)}? <a href="/${esc(city.slug)}/add/">Tell visitors what they get wrong.</a></div>`}</div>
${editorsHtml(city, intro)}
${nearbyHtml(nearby)}`;
}

/* ---------------- minify ---------------- */

async function minifyHtml(html, label) {
  let out = html;
  for (const m of [...out.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]) {
    const [full, attrs, code] = m;
    if (!code.trim()) continue;
    // JSON-LD is data, not JavaScript — the js loader would choke on a bare
    // object literal. Leave it as-is (JSON.stringify already produced it tight).
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) continue;
    const r = await transform(code, { loader: "js", minify: true, target: "es2020" });
    // Replacement must be a FUNCTION. Minified JS routinely contains $& (e.g.
    // a variable renamed to $ followed by &&), and String.replace treats that
    // as "insert the whole match" — which silently re-injects the original
    // <script> block after the minified one and breaks the page.
    const scriptOut = `<script${attrs}>${r.code.trim()}</script>`;
    out = out.replace(full, () => scriptOut);
  }
  for (const m of [...out.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)]) {
    const [full, attrs, css] = m;
    if (!css.trim()) continue;
    const r = await transform(css, { loader: "css", minify: true });
    const styleOut = `<style${attrs}>${r.code.trim()}</style>`;
    out = out.replace(full, () => styleOut);
  }
  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, "").replace(/\n{2,}/g, "\n");

  // Minifying must never grow a file or change how many scripts it has.
  // Both are symptoms of a replacement-string bug rather than a size win.
  const before = (html.match(/<script/g) || []).length;
  const after = (out.match(/<script/g) || []).length;
  if (after !== before) {
    throw new Error(`minify: ${label || "page"} script count changed ${before} -> ${after}`);
  }
  if (out.length > html.length) {
    throw new Error(`minify: ${label || "page"} grew ${html.length} -> ${out.length} bytes`);
  }

  if (label) report.push([label, html.length, out.length]);
  return out;
}

// Browsers keep /assets/* for a day (see _headers), so a changed tv.js or
// site.css would otherwise reach returning visitors up to a day late. Every
// HTML file gets ?v=<content hash> on its asset URLs: same file, same URL
// (still cached); changed file, new URL (fetched immediately).
const ASSET_VERSION = {};
for (const e of await readdir("assets", { withFileTypes: true })) {
  if (!e.isFile()) continue;
  const f = e.name;
  ASSET_VERSION[f] = createHash("sha256").update(await readFile(join("assets", f))).digest("hex").slice(0, 10);
}

/* ---------------- vendored Supabase client ----------------
   The pages used to load supabase-js from a CDN at a floating "@2" version with
   no integrity hash: whatever the CDN served ran on every page, the admin page
   included. It is bundled here instead from the pinned npm dependency
   (package-lock.json), served as /assets/supabase.js with the same content-hash
   versioning as the site's own scripts, and the CDN is no longer in the CSP. */
const SUPABASE_BUNDLE = (await bundle({
  stdin: { contents: 'export * from "@supabase/supabase-js";', resolveDir: process.cwd(), loader: "js" },
  bundle: true, format: "iife", globalName: "supabase", minify: true, target: "es2020",
  platform: "browser", write: false, logLevel: "silent", legalComments: "none"
})).outputFiles[0].text;
ASSET_VERSION["supabase.js"] = createHash("sha256").update(SUPABASE_BUNDLE).digest("hex").slice(0, 10);
const versionAssets = html => html.replace(/(["'])\/assets\/([\w.-]+)\1/g,
  (m, q, f) => ASSET_VERSION[f] ? `${q}/assets/${f}?v=${ASSET_VERSION[f]}${q}` : m);

// Logo / favicon links for every page (files: scripts/brand_assets.py).
const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#ff5630">`;

// One footer on every public page (About, Privacy, Terms, contact). Pages that
// carried their own footer get this one instead; the admin page gets none.
const SITE_FOOTER = `<footer class="site-foot"><div class="wrap">
<div class="sf-brand"><b>TripVibz</b><span class="tagline">The local take on every city.</span></div>
<nav class="sf-links" aria-label="Site"><a href="/cities/">Cities</a><a href="/about/">About</a><a href="/about/#contact">Contact</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></nav>
<div class="sf-note">© ${new Date().getFullYear()} TripVibz · A city guide written by the people who live there.</div>
</div></footer>`;

async function emit(path, html) {
  if (typeof html === "string" && path.endsWith(".html") && !/(^|\/)admin\.html$/.test(path) && /<\/body>/i.test(html)) {
    html = html.replace(/<footer[\s\S]*?<\/footer>\s*/gi, "").replace(/<\/body>/i, () => SITE_FOOTER + "</body>");
  }
  if (typeof html === "string" && path.endsWith(".html")) {
    if (!html.includes('rel="icon"')) html = html.replace(/<\/head>/i, () => ICON_LINKS + "</head>");
    html = versionAssets(html);
  }
  const full = join(OUT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, html);
}

/* ---------------- static assets ---------------- */

async function walk(dir, rel = "") {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const from = join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;

    if (e.isDirectory()) { await walk(from, relPath); continue; }

    const ext = extname(e.name).toLowerCase();
    const raw = await readFile(from);

    if (ext === ".html") {
      await emit(relPath, await minifyHtml(raw.toString("utf8"), relPath));
    } else if (ext === ".js" || ext === ".mjs") {
      const src = raw.toString("utf8");
      const r = await transform(src, { loader: "js", minify: true, target: "es2020" });
      await emit(relPath, r.code);
      report.push([relPath, src.length, r.code.length]);
    } else if (ext === ".css") {
      const src = raw.toString("utf8");
      const r = await transform(src, { loader: "css", minify: true });
      await emit(relPath, r.code);
      report.push([relPath, src.length, r.code.length]);
    } else {
      await emit(relPath, raw);
    }
  }
}

/* ---------------- run ---------------- */

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await walk(SRC);
await emit("assets/supabase.js", SUPABASE_BUNDLE);
report.push(["assets/supabase.js (vendor)", SUPABASE_BUNDLE.length, SUPABASE_BUNDLE.length]);

/* ---------------- _headers ----------------
   Security headers come from functions/_security.js (shared with the Functions
   that render HTML). Cloudflare combines every matching rule, so the more
   specific cache rules detach ("! Cache-Control") the generic one first —
   otherwise assets were served with two contradictory Cache-Control values. */
const { SECURITY_HEADERS } = await import("./functions/_security.js");
const secLines = Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`).join("\n");
await emit("_headers", `# Generated by build.mjs — edit functions/_security.js, not this file.
# Note: city photos come from Supabase, so their cache-control is set there.

# Every page and asset: security headers + a short HTML cache so pre-rendered
# content updates propagate on rebuild.
/*
${secLines}
  Cache-Control: public, max-age=600, must-revalidate

# Same-origin assets carry ?v=<content hash> in page HTML, so they can be kept a day.
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/*.webp
  ! Cache-Control
  Cache-Control: public, max-age=604800

/*.svg
  ! Cache-Control
  Cache-Control: public, max-age=604800
`);

console.log("\n  fetching content…");
const { cities, posts, events } = await loadContent();
cities.forEach(c => { if (c.photo) PHOTO_BY_SLUG[c.slug] = c.photo; });
console.log(`  ${cities.length} cities · ${posts.length} posts · ${events.length} events`);

let INTROS = {};
try { INTROS = JSON.parse(await readFile("data/editorial/intros.json", "utf8")); }
catch { console.warn("  (no data/editorial/intros.json — city pages build without editor intros)"); }

const articleTpl = await readFile("article.html", "utf8");
const cityTpl = await readFile("city.html", "utf8");
const voteTpl = await readFile("vote.html", "utf8");
const addTpl = await readFile("add.html", "utf8");
const indexTpl = await readFile("index.html", "utf8");
const placesTpl = await readFile("places.html", "utf8");

const countsBySlug = {};
for (const c of cities) {
  countsBySlug[c.slug] = posts.filter(p => p.city_id === c.id).length;
}

const newest = rows => rows.length
  ? rows.map(r => r.created_at).sort().slice(-1)[0].slice(0, 10)
  : new Date().toISOString().slice(0, 10);

// home + cities index
pages.push({ path: "/", lastmod: newest(posts), priority: "1.0" });
await emit("index.html", await minifyHtml(render(indexTpl, {
  title: "TripVibz — what locals know that travel sites don't",
  desc: "Locals tell visitors what to avoid, when not to come, and what the guidebooks get wrong. One sentence at a time.",
  canonical: `${SITE}/`,
  image: `${SITE}/assets/og/home.jpg`,
  og: ogCard("home.jpg", "The local take on every city.",
    `${cities.length} cities and counting. One-tap questions like “Navy Pier: worth it, or skip it?” See what locals say before you book.`),
  body: cityGrid(cities, countsBySlug),
  mount: "needs",
  jsonLd: homeLd()
}), null));

pages.push({ path: "/cities/", lastmod: newest(posts), priority: "0.8" });
pages.push({ path: "/about/", lastmod: new Date().toISOString().slice(0, 10), priority: "0.3" });
await emit("cities/index.html", await minifyHtml(render(placesTpl, {
  title: "Every city on TripVibz — local guides by residents",
  desc: "Browse cities where locals have written what visitors get wrong, when not to visit, and what residents actually do.",
  canonical: `${SITE}/cities/`,
  image: `${SITE}/assets/og/cities.jpg`,
  og: ogCard("cities.jpg", "Pick your city: what do tourists get wrong there?",
    `Locals in ${cities.length} cities vote on what visitors get wrong. Don't see yours? One tap to ask for it.`),
  body: cityList(cities, countsBySlug),
  mount: "live-grid"
}), null));

let cityCount = 0, articleCount = 0;
for (const city of cities) {
  const cityPosts = posts.filter(p => p.city_id === city.id);
  const cityEvents = events.filter(e => e.city_id === city.id);
  const counts = {};
  cityPosts.forEach(p => { counts[p.type] = (counts[p.type] || 0) + 1; });
  const feedTakes = cityPosts.filter(p => THEMES[p.type]);
  const intro = cityPosts.length < INTRO_MIN_TAKES && typeof INTROS[city.slug] === "string" ? INTROS[city.slug] : "";
  // Indexable once there's something real: the editors' intro or 3+ takes.
  const cityIndexable = !!intro || cityPosts.length >= INTRO_MIN_TAKES;

  await emit(`${city.slug}/index.html`, await minifyHtml(render(cityTpl, {
    title: `${city.name}${city.state ? ", " + city.state : ""} — what locals say`,
    // A city-specific description (from the editors' intro) beats one template
    // line repeated across 27 pages.
    desc: intro ? clip(intro, 155) : `Local guides for ${city.name}: what not to do, the worst times to visit, and what residents actually do.`,
    canonical: `${SITE}/${city.slug}/`,
    image: shareCard(city) ? shareCard(city).image : photo(city.slug),
    og: shareCard(city) || undefined,
    body: cityBody(city, counts, feedTakes, intro, nearbyCities(city, cities)),
    mount: "city",
    jsonLd: cityLd(city, `${SITE}/${city.slug}/`, feedTakes),
    // Empty pages stay reachable for people (links, email, social) but out of
    // Google until there is something real on them: the editors' intro or
    // 3+ takes. Thin pages drag the whole site's quality down.
    noindex: !cityIndexable
  }), null));
  if (cityIndexable) pages.push({ path: `/${city.slug}/`, lastmod: cityPosts.length ? newest(cityPosts) : new Date().toISOString().slice(0, 10), priority: "0.8" });
  cityCount++;

  // App pages: one-tap voting (email links land here) and posting. Not for Google.
  await emit(`${city.slug}/vote/index.html`, await minifyHtml(render(voteTpl, {
    title: `Locals, settle this: ${city.name} · TripVibz`,
    desc: `Quick questions for people who live in ${city.name}. One tap each.`,
    canonical: `${SITE}/${city.slug}/`, image: shareCard(city) ? shareCard(city).image : photo(city.slug),
    og: shareCard(city) || undefined, noindex: true
  }), null));
  await emit(`${city.slug}/add/index.html`, await minifyHtml(render(addTpl, {
    title: `What do tourists get wrong about ${city.name}? · TripVibz`,
    desc: `Tell visitors one thing they get wrong about ${city.name}. One sentence is enough.`,
    canonical: `${SITE}/${city.slug}/`, image: `${SITE}/assets/og/${city.slug}-add.jpg`, noindex: true,
    og: ogCard(`${city.slug}-add.jpg`, `${city.name} locals: what do tourists get wrong?`,
      "Say it in one sentence. Locals vote it True or Nope. The first 10 signed-in locals become founding locals.")
  }), null));

  for (const theme of Object.keys(THEMES)) {
    const takes = cityPosts.filter(p => p.type === theme);
    const t = THEMES[theme];
    // The worst-times calendar is real content on its own.
    const hasContent = takes.length > 0 || (theme === "worst_times" && cityEvents.length > 0);
    await emit(`${city.slug}/${t.slug}/index.html`, await minifyHtml(render(articleTpl, {
      title: `${t.title(city.name)} (${new Date().getFullYear()}) — by locals`,
      desc: t.desc(city.name),
      canonical: `${SITE}/${city.slug}/${t.slug}/`,
      image: `${SITE}/assets/og/${city.slug}-${t.slug}.jpg`,
      og: ogCard(`${city.slug}-${t.slug}.jpg`, `${t.title(city.name)}, according to locals`,
        takes.length
          ? `“${[...takes].sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs))[0].title}” and ${takes.length > 1 ? `${takes.length - 1} more` : "more"} from locals. True or nope?`
          : t.desc(city.name)),
      body: articleBody(city, theme, takes, cityEvents),
      jsonLd: articleLd(city, theme, takes, `${SITE}/${city.slug}/${t.slug}/`, t, photo(city.slug)),
      noindex: !hasContent
    }), null));
    if (hasContent) pages.push({
      path: `/${city.slug}/${t.slug}/`,
      lastmod: newest(takes.length ? takes : cityPosts),
      priority: takes.length ? "0.9" : "0.6"
    });
    articleCount++;
  }
}

// sitemap + robots
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${SITE}${p.path}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <priority>${p.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
await emit("sitemap.xml", sitemap);

await emit("robots.txt", `User-agent: *
Allow: /

# Query-string pages are the interactive fallbacks; the canonical content
# lives at the clean paths listed in the sitemap.
Disallow: /*?add=
Disallow: /place.html
Disallow: /admin.html

Sitemap: ${SITE}/sitemap.xml
`);

await emit("_redirects", `# Old query-param URLs -> clean paths
/article.html  /  301
/city.html     /cities/  301
/places.html   /cities/  301
/map.html      /cities/  301
/map           /cities/  301
`);

let before = 0, after = 0;
console.log("\n  file                     before     after    saved");
console.log("  " + "-".repeat(52));
for (const [name, b, a] of report.sort((x, y) => y[1] - x[1])) {
  before += b; after += a;
  console.log(`  ${name.padEnd(24)} ${bytes(b).padStart(8)} ${bytes(a).padStart(9)}  ${String(Math.round((1 - a / b) * 100)).padStart(4)}%`);
}
console.log("  " + "-".repeat(52));
console.log(`  ${"assets total".padEnd(24)} ${bytes(before).padStart(8)} ${bytes(after).padStart(9)}  ${String(Math.round((1 - after / before) * 100)).padStart(4)}%`);
console.log(`\n  pre-rendered: ${cityCount} city pages, ${articleCount} articles`);
console.log(`  sitemap:      ${pages.length} URLs\n`);
