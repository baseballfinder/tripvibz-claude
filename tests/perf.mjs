// Performance budgets on the built site (dist/). No browser; deterministic;
// fails the build when something gets heavier than it should.
// `node build.mjs && node tests/perf.mjs`
//
// Lighthouse (lighthouserc.json, run by tests.yml) measures what a browser
// experiences — speed scores, layout shift, blocking time. These budgets are
// the simpler, exact half: file sizes, so a 2 MB script or a 600 KB page can't
// slip in because a scoring run happened to be lenient that day.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n")[0]]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const KB = 1024;
const kb = n => `${Math.round(n / KB)} KB`;
async function files(dir, pred = () => true) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}
const size = async p => (await stat(p)).size;
const gz = async p => gzipSync(await readFile(p)).length;

// ---- budgets (raw bytes unless "gz") — current values in comments, Oct 2026 ----
const BUDGET = {
  pageHtml: 60 * KB,          // largest page: 28 KB (worst-times pages)
  pageHtmlGz: 15 * KB,        // ~5-8 KB
  siteJs: 60 * KB,            // tv.js 15 KB, v2.js 23 KB, analytics.js 2 KB
  vendorJs: 260 * KB,         // bundled supabase-js: 215 KB (57 KB gz)
  jsTotalGz: 90 * KB,         // everything a page can load: ~73 KB gz
  css: 25 * KB,               // v2.css 18 KB, site.css 9 KB
  ogImage: 200 * KB,          // share cards: 110-157 KB each
  brandImage: 120 * KB,       // app icons / logos
  sitemapUrls: 400,           // 61 today; a runaway generator would blow this
  distTotal: 40 * 1024 * KB   // 23 MB (mostly the 164 share cards)
};

await test(`Every pre-rendered page is under ${kb(BUDGET.pageHtml)} (and ${kb(BUDGET.pageHtmlGz)} compressed)`, async () => {
  for (const f of await files("dist", p => p.endsWith(".html"))) {
    const s = await size(f);
    assert(s <= BUDGET.pageHtml, `${f} is ${kb(s)}`);
    if (s > BUDGET.pageHtmlGz) assert((await gz(f)) <= BUDGET.pageHtmlGz, `${f} is ${kb(await gz(f))} gzipped`);
  }
});

await test(`Site scripts ≤ ${kb(BUDGET.siteJs)} each, vendored client ≤ ${kb(BUDGET.vendorJs)}, all scripts ≤ ${kb(BUDGET.jsTotalGz)} compressed`, async () => {
  let totalGz = 0;
  for (const f of await files("dist/assets", p => p.endsWith(".js"))) {
    const s = await size(f);
    const limit = f.endsWith("/supabase.js") ? BUDGET.vendorJs : BUDGET.siteJs;
    assert(s <= limit, `${f} is ${kb(s)} (limit ${kb(limit)})`);
    totalGz += await gz(f);
  }
  assert(totalGz <= BUDGET.jsTotalGz, `all scripts together are ${kb(totalGz)} gzipped`);
});

await test(`Stylesheets ≤ ${kb(BUDGET.css)} each`, async () => {
  for (const f of await files("dist/assets", p => p.endsWith(".css"))) {
    const s = await size(f);
    assert(s <= BUDGET.css, `${f} is ${kb(s)}`);
  }
});

await test(`Share images ≤ ${kb(BUDGET.ogImage)}, brand images ≤ ${kb(BUDGET.brandImage)}`, async () => {
  for (const f of await files("dist/assets/og", p => /\.(jpe?g|png|webp)$/.test(p)))
    assert((await size(f)) <= BUDGET.ogImage, `${f} is ${kb(await size(f))}`);
  for (const f of await files("dist/assets/brand", p => /\.(jpe?g|png|webp)$/.test(p)))
    assert((await size(f)) <= BUDGET.brandImage, `${f} is ${kb(await size(f))}`);
});

await test("Pages don't ship uncompressed inline data (no base64 blobs over 4 KB, no inline SVG over 8 KB)", async () => {
  for (const f of await files("dist", p => p.endsWith(".html"))) {
    const h = await readFile(f, "utf8");
    for (const m of h.matchAll(/data:[a-z/+.-]+;base64,([A-Za-z0-9+/=]+)/g)) assert(m[1].length <= 4 * KB, `${f}: inline base64 blob of ${kb(m[1].length)}`);
    for (const m of h.matchAll(/<svg[\s\S]*?<\/svg>/g)) assert(m[0].length <= 8 * KB, `${f}: inline SVG of ${kb(m[0].length)}`);
  }
});

await test("City grid photos are lazy-loaded with fixed dimensions (no layout shift, no eager 3 MB)", async () => {
  for (const f of ["dist/index.html", "dist/cities/index.html"]) {
    const h = await readFile(f, "utf8");
    // The grid is drawn by the page script; its <img> template (minified
    // variable names vary) is the one whose src ends in the city's photo.
    const grid = (h.match(/<img[^>]*\.photo\|\|[^>]*>/g) || []);
    assert(grid.length, `${f}: no city photo <img> found`);
    for (const img of grid) assert(/loading="lazy"/.test(img) && /width=/.test(img) && /height=/.test(img), `${f}: city photo <img> must have loading="lazy", width and height: ${img.slice(0, 80)}`);
  }
});

await test(`Sitemap has ≤ ${BUDGET.sitemapUrls} URLs; dist is under ${kb(BUDGET.distTotal)}`, async () => {
  const sm = await readFile("dist/sitemap.xml", "utf8");
  const n = (sm.match(/<loc>/g) || []).length;
  assert(n > 0 && n <= BUDGET.sitemapUrls, `sitemap has ${n} URLs`);
  let total = 0;
  for (const f of await files("dist")) total += await size(f);
  assert(total <= BUDGET.distTotal, `dist is ${kb(total)}`);
});

for (const r of results) console.log(r.join("  "));
const failed = results.filter(r => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
