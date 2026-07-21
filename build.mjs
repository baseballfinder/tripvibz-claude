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

// Dynamic so a missing dependency produces an instruction rather than a
// module-resolution stack trace.
let transform;
try {
  ({ transform } = await import("esbuild"));
} catch {
  console.error("\n  esbuild isn't installed.\n");
  console.error("  Run this first:\n");
  console.error("      npm install\n");
  process.exit(1);
}

const SRC = ".";
const OUT = "dist";
const SITE = process.env.SITE_URL || "https://tripvibz.com";

const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

// "functions" stays out: Cloudflare Pages compiles it from the project root,
// so copying it into the output would upload the handler as a static asset.
const SKIP = new Set([
  "dist", "node_modules", ".git", "supabase", ".github", "functions",
  "build.mjs", "package.json", "package-lock.json"
]);

const THEMES = {
  what_not_to_do: {
    slug: "what-not-to-do",
    nav: "What not to do",
    title: c => `What not to do in ${c}`,
    lede: c => `The mistakes visitors make in ${c}, according to people who live there. Ranked by how many locals cosigned them.`,
    desc: c => `Local advice on what not to do in ${c} — the mistakes visitors make, written and ranked by people who live there.`
  },
  worst_times: {
    slug: "worst-times-to-visit",
    nav: "Worst times to visit",
    title: c => `Worst times to visit ${c}`,
    lede: c => `The weeks, days and hours locals would tell you to avoid in ${c} — and what to do instead.`,
    desc: c => `The worst times to visit ${c}, month by month — festivals, seasons and weeks locals say to avoid.`
  },
  hidden_gem: {
    slug: "what-locals-do",
    nav: "What locals actually do",
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
      fetchTable("cities", "select=id,name,state,slug&order=sort"),
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

function head({ title, desc, canonical, image }) {
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="TripVibz" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(canonical)}" />
${image ? `<meta property="og:image" content="${esc(image)}" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
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
function render(template, { title, desc, canonical, image, body, mount = "root" }) {
  let out = template.replace(/<meta name="description"[^>]*>\s*/g, "");
  out = out.replace(/<title>[\s\S]*?<\/title>/, head({ title, desc, canonical, image }));
  if (body) out = injectInto(out, mount, body);
  return out;
}

const photo = slug => `${SUPABASE_URL}/storage/v1/object/public/city-photos/${slug}.webp`;

/* ---------------- article body ---------------- */

function articleBody(city, theme, takes, events) {
  const t = THEMES[theme];
  const list = takes
    .slice()
    .sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs) ||
                    new Date(a.created_at) - new Date(b.created_at));

  const entries = list.length
    ? `<ol class="entries">${list.map(p => `<li class="entry"><div class="t">${esc(p.title)}</div>${
        p.body ? `<div class="more">${esc(p.body)}</div>` : ""
      }<div class="foot"><span class="who">${p.ups} cosign${p.ups === 1 ? "" : "s"}</span></div></li>`).join("")}</ol>`
    : `<div class="empty-article"><b>Nobody's written this one yet</b>
       <p>${esc(city.name)} needs locals. One sentence is genuinely enough.</p></div>`;

  const cal = theme === "worst_times" && events.length
    ? `<section class="cal"><h2>${esc(city.name)} month by month</h2>${
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
<div class="themes">${Object.keys(THEMES).map(k =>
  `<a class="${k === theme ? "on" : ""}" href="/${esc(city.slug)}/${THEMES[k].slug}/">${esc(THEMES[k].nav)}</a>`).join("")}</div>
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

function cityBody(city, counts) {
  return `<a class="back" href="/cities/">← All cities</a>
<div class="city-head"><h1>${esc(city.name)}${city.state ? ", " + esc(city.state) : ""}</h1></div>
<div class="articles">${Object.keys(THEMES).map(k => {
    const n = counts[k] || 0;
    return `<a class="art" href="/${esc(city.slug)}/${THEMES[k].slug}/">
      <h3>${esc(THEMES[k].title(city.name))}</h3>
      <div class="go">${n ? `${n} local take${n === 1 ? "" : "s"} →` : "Needs locals — add the first →"}</div></a>`;
  }).join("")}</div>`;
}

/* ---------------- minify ---------------- */

async function minifyHtml(html, label) {
  let out = html;
  for (const m of [...out.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]) {
    const [full, attrs, code] = m;
    if (!code.trim()) continue;
    const r = await transform(code, { loader: "js", minify: true, target: "es2020" });
    out = out.replace(full, `<script${attrs}>${r.code.trim()}</script>`);
  }
  for (const m of [...out.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)]) {
    const [full, attrs, css] = m;
    if (!css.trim()) continue;
    const r = await transform(css, { loader: "css", minify: true });
    out = out.replace(full, `<style${attrs}>${r.code.trim()}</style>`);
  }
  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, "").replace(/\n{2,}/g, "\n");
  if (label) report.push([label, html.length, out.length]);
  return out;
}

async function emit(path, html) {
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

console.log("\n  fetching content…");
const { cities, posts, events } = await loadContent();
console.log(`  ${cities.length} cities · ${posts.length} posts · ${events.length} events`);

const articleTpl = await readFile("article.html", "utf8");
const cityTpl = await readFile("city.html", "utf8");
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
  title: "TripVibz — what locals know that guidebooks don't",
  desc: "Locals tell visitors what to avoid, when not to come, and what the guidebooks get wrong. One sentence at a time.",
  canonical: `${SITE}/`,
  image: photo("key-west"),
  body: cityGrid(cities, countsBySlug),
  mount: "needs"
}), null));

pages.push({ path: "/cities/", lastmod: newest(posts), priority: "0.8" });
await emit("cities/index.html", await minifyHtml(render(placesTpl, {
  title: "Every city on TripVibz — local guides by residents",
  desc: "Browse cities where locals have written what visitors get wrong, when not to visit, and what residents actually do.",
  canonical: `${SITE}/cities/`,
  body: cityList(cities, countsBySlug),
  mount: "live-grid"
}), null));

let cityCount = 0, articleCount = 0;
for (const city of cities) {
  const cityPosts = posts.filter(p => p.city_id === city.id);
  const cityEvents = events.filter(e => e.city_id === city.id);
  const counts = {};
  cityPosts.forEach(p => { counts[p.type] = (counts[p.type] || 0) + 1; });

  await emit(`${city.slug}/index.html`, await minifyHtml(render(cityTpl, {
    title: `${city.name}${city.state ? ", " + city.state : ""} — what locals say`,
    desc: `Local guides for ${city.name}: what not to do, the worst times to visit, and what residents actually do.`,
    canonical: `${SITE}/${city.slug}/`,
    image: photo(city.slug),
    body: cityBody(city, counts),
    mount: "city"
  }), null));
  pages.push({ path: `/${city.slug}/`, lastmod: newest(cityPosts), priority: "0.8" });
  cityCount++;

  for (const theme of Object.keys(THEMES)) {
    const takes = cityPosts.filter(p => p.type === theme);
    const t = THEMES[theme];
    await emit(`${city.slug}/${t.slug}/index.html`, await minifyHtml(render(articleTpl, {
      title: `${t.title(city.name)} (${new Date().getFullYear()}) — by locals`,
      desc: t.desc(city.name),
      canonical: `${SITE}/${city.slug}/${t.slug}/`,
      image: photo(city.slug),
      body: articleBody(city, theme, takes, cityEvents)
    }), null));
    pages.push({
      path: `/${city.slug}/${t.slug}/`,
      lastmod: newest(takes.length ? takes : cityPosts),
      priority: takes.length ? "0.9" : "0.5"
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
Disallow: /thread.html
Disallow: /admin.html

Sitemap: ${SITE}/sitemap.xml
`);

await emit("_redirects", `# Old query-param URLs -> clean paths
/article.html  /  301
/city.html     /cities/  301
/places.html   /cities/  301
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
