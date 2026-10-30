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
  pageHtmlGz: 20 * KB,        // 8-15 KB with the stylesheets inlined
  siteJs: 60 * KB,            // tv.js 15 KB, v2.js 23 KB, analytics.js 2 KB
  vendorJs: 140 * KB,         // PostgREST + Auth client (lib/supabase-client.mjs): 120 KB (30 KB gz)
  jsTotalGz: 60 * KB,         // everything a page can load: ~45 KB gz
  css: 25 * KB,               // v2.css 18 KB, site.css 9 KB
  ogImage: 200 * KB,          // share cards: 110-157 KB each
  brandImage: 120 * KB,       // app icons / logos
  fontFile: 60 * KB,          // variable woff2, latin subset: 27-35 KB each
  fontsTotal: 120 * KB,       // 3 files, 90 KB
  sitemapUrls: 400,           // 61 today; a runaway generator would blow this
  cityPhoto: { 256: 20 * KB, 360: 30 * KB, 480: 45 * KB, 640: 70 * KB, 720: 80 * KB, 800: 110 * KB, "short-720": 60 * KB, "short-800": 80 * KB },  // 14/22/38/55/25/35 KB (Fort Lauderdale); Key West 800 is 101 KB
  distTotal: 60 * 1024 * KB   // 29 MB (share cards 20 MB, city photos 6 MB)
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

await test("City photos: every city has local 256-800 px + short 720/800 WebP copies within budget", async () => {
  const cities = await (await fetch("https://nkxorlktzbgwqnfwmuus.supabase.co/rest/v1/cities?select=slug,photo", { headers: { apikey: "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB" } })).json();
  assert(Array.isArray(cities) && cities.length, "could not read the cities table");
  for (const c of cities) {
    const base = (c.photo || `${c.slug}.webp`).replace(/\.[a-z0-9]+$/i, "");
    for (const [variant, limit] of Object.entries(BUDGET.cityPhoto)) {
      const f = `dist/assets/city/${base}-${variant}.webp`;
      const s = await size(f).catch(() => null);
      assert(s !== null, `${f} missing (photo pipeline in build.mjs)`);
      assert(s <= limit, `${f} is ${kb(s)} (limit ${kb(limit)})`);
    }
  }
});

await test("Hero photo is in the HTML of every city and topic page: local srcset, fetchpriority=high, preloaded, no Supabase src", async () => {
  const pages = (await files("dist", p => /^dist\/[a-z0-9-]+\/(index|(what-not-to-do|worst-times-to-visit|what-locals-do)\/index)\.html$/.test(p)))
    .filter(p => !/^dist\/(cities|about|privacy|terms|how-we-verify-locals)\//.test(p));
  assert(pages.length >= 100, `only ${pages.length} city/topic pages found`);
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    const img = (h.match(/<img class="city-hero[^"]*" id="tv-hero"[^>]*>/) || [])[0];
    assert(img, `${f}: pre-rendered hero <img id="tv-hero"> missing`);
    assert(/src="\/assets\/city\//.test(img) && /srcset="[^"]*\/assets\/city\//.test(img), `${f}: hero must use the local resized copies`);
    assert(/fetchpriority="high"/.test(img) && /width="800"/.test(img) && /height="\d+"/.test(img), `${f}: hero needs fetchpriority=high and dimensions`);
    assert(!/loading="lazy"/.test(img), `${f}: the LCP image must not be lazy`);
    assert(/<link rel="preload" as="image" href="\/assets\/city\/[^"]+"[^>]*fetchpriority="high"/.test(h), `${f}: hero preload link missing`);
  }
});

await test("Stylesheets are inlined (no render-blocking <link rel=stylesheet>)", async () => {
  for (const f of await files("dist", p => p.endsWith(".html"))) {
    const h = await readFile(f, "utf8");
    assert(!/<link[^>]*rel="stylesheet"/.test(h), `${f}: still links a stylesheet`);
    assert(/<style>/.test(h), `${f}: no inline <style>`);
  }
});

await test("City grid photos: pre-rendered with local srcset and dimensions; first rows eager, the rest lazy (script template matches)", async () => {
  for (const [f, container] of [["dist/index.html", "needs"], ["dist/cities/index.html", "live-grid"]]) {
    const h = await readFile(f, "utf8");
    // Pre-rendered tiles (build.mjs gridImg): what the browser sees before any script runs.
    assert(h.includes(`id="${container}"`), `${f}: #${container} missing`);
    const imgs = h.match(/<img [^>]*src="\/assets\/city\/[^>]*>/g) || [];   // every city photo on these pages is a tile
    assert(imgs.length >= 10, `${f}: expected pre-rendered city tiles with local photos, found ${imgs.length}`);
    imgs.forEach((img, i) => {
      assert(/srcset="[^"]*\/assets\/city\//.test(img) && /sizes="/.test(img), `${f}: tile ${i} needs srcset + sizes`);
      assert(/width="\d+"/.test(img) && /height="\d+"/.test(img), `${f}: tile ${i} needs width and height`);
      assert(new RegExp(`loading="${i < 8 ? "eager" : "lazy"}"`).test(img), `${f}: tile ${i} should be ${i < 8 ? "eager" : "lazy"}`);
      assert(/fetchpriority="high"/.test(img) === (i < 2), `${f}: tile ${i} ${i < 2 ? "should" : "should not"} be fetchpriority=high (the first two are the LCP candidates on a phone)`);
    });
    // The script's own template must do the same, or hydration swaps in lazy tiles.
    const tpl = (h.match(/<img[^>]*cityPhotoAttrs\([^>]*>/g) || [])[0];
    assert(tpl && /loading="\$\{[^}]*<\s*8[^}]*\}"/.test(tpl) && /width=/.test(tpl) && /height=/.test(tpl), `${f}: script tile template must use the eager/lazy split and dimensions: ${(tpl || "").slice(0, 80)}`);
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
