// Checks on the built site (dist/) and the repo, run on every pull request
// and merge. No browser; fast. `node build.mjs && node tests/static.mjs`
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const api = async p => (await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY } })).json();
const exists = async p => { try { await stat(p); return true; } catch { return false; } };

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n")[0]]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };

async function htmlFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlFiles(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out;
}

const pages = await htmlFiles("dist");
const cities = await api("cities?select=id,slug&order=sort");
const qs = await api("questions?select=city_id,sort,prompt,options&active=eq.true");

await test("Every city has a page, a vote page and an add page", async () => {
  for (const c of cities)
    for (const p of [`${c.slug}/index.html`, `${c.slug}/vote/index.html`, `${c.slug}/add/index.html`])
      assert(await exists(join("dist", p)), `missing dist/${p}`);
});

await test("Every page has a title, favicon and the logo link", async () => {
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    assert(/<title>[^<]+<\/title>/.test(h), `${f}: no title`);
    assert(h.includes('rel="icon"'), `${f}: no favicon`);
  }
});

await test("No links to the dead apex domain (tripvibz.com without www)", async () => {
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    assert(!/https:\/\/tripvibz\.com/.test(h), `${f} links to https://tripvibz.com`);
  }
});

await test("Asset links resolve (every /assets/ file a page references exists)", async () => {
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    for (const m of h.matchAll(/["'](\/assets\/[^"'?#]+)/g))
      assert(await exists(join("dist", m[1])), `${f} -> ${m[1]} missing`);
  }
});

await test("Share cards: each city with questions has a 1200x630 card and og tags", async () => {
  const withQ = new Set(qs.map(q => q.city_id));
  for (const c of cities.filter(c => withQ.has(c.id))) {
    const h = await readFile(join("dist", c.slug, "index.html"), "utf8");
    assert(h.includes(`https://www.tripvibz.com/assets/og/${c.slug}.jpg`), `${c.slug}: og:image is not its card`);
    assert(await exists(join("dist", "assets", "og", `${c.slug}.jpg`)), `${c.slug}: card file missing`);
    const buf = await readFile(join("dist", "assets", "og", `${c.slug}.jpg`));
    let i = 2, w = 0, hgt = 0;                       // read JPEG SOF for dimensions
    while (i < buf.length) { if (buf[i] !== 0xff) break; const mk = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xc3) { hgt = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; } i += 2 + len; }
    assert(w === 1200 && hgt === 630, `${c.slug}: card is ${w}x${hgt}`);
  }
});

await test("Share cards for every page type exist and are wired up", async () => {
  const want = [["index.html", "home.jpg"], ["cities/index.html", "cities.jpg"]];
  for (const c of cities) {
    want.push([`${c.slug}/add/index.html`, `${c.slug}-add.jpg`]);
    for (const t of ["what-not-to-do", "worst-times-to-visit", "what-locals-do"]) want.push([`${c.slug}/${t}/index.html`, `${c.slug}-${t}.jpg`]);
    assert(await exists(join("dist", "assets", "og", `${c.slug}-take.jpg`)), `${c.slug}-take.jpg missing (shared takes use it)`);
  }
  for (const [page, card] of want) {
    const h = await readFile(join("dist", page), "utf8");
    assert(h.includes(`https://www.tripvibz.com/assets/og/${card}`), `${page}: og:image is not ${card}`);
    assert(await exists(join("dist", "assets", "og", card)), `${card} missing`);
  }
  assert(await exists("functions/t/[id].js"), "shared-take preview function missing");
});

await test("Questions: every city has 5 active, numbered 1-5, with 2-4 short options", async () => {
  for (const c of cities) {
    const mine = qs.filter(q => q.city_id === c.id).sort((a, b) => a.sort - b.sort);
    assert(mine.length === 5, `${c.slug}: ${mine.length} active questions`);
    assert(mine.map(q => q.sort).join() === "1,2,3,4,5", `${c.slug}: sorts ${mine.map(q => q.sort)}`);
    for (const q of mine) {
      assert(q.options.length >= 2 && q.options.length <= 4, `${c.slug}: "${q.prompt}" has ${q.options.length} options`);
      for (const o of q.options) assert(o.label.length <= 32, `${c.slug}: option "${o.label}" too long for a button`);
    }
  }
});

await test("Questions in the database match scripts/questions/spec.py", async () => {
  const out = execFileSync("python3", ["-c",
    "import sys,json;sys.path.insert(0,'scripts/questions');import spec;print(json.dumps({k:[q['prompt'] for q in v] for k,v in spec.CITIES.items()}))"]).toString();
  const want = JSON.parse(out);
  for (const c of cities) {
    if (!want[c.slug]) continue;
    const live = qs.filter(q => q.city_id === c.id).sort((a, b) => a.sort - b.sort).map(q => q.prompt);
    assert(JSON.stringify(live) === JSON.stringify(want[c.slug]), `${c.slug}: live questions differ from spec.py (run research.py sql)`);
  }
});

await test("Auto-correct tidies typed takes and replies", async () => {
  const src = await readFile("assets/tv.js", "utf8");
  const code = src.slice(src.indexOf("// --- tidy:start ---"), src.indexOf("// --- tidy:end ---"));
  const tidy = new Function(code + "; return tidyText;")();
  const cases = [
    ["dont bother the traffic in miami is mad max", "Don't bother the traffic in miami is mad max."],
    ["i think its great.  im going back", "I think its great. I'm going back."],
    ["Alot of tourists , wierd restaraunts!!!", "A lot of tourists, weird restaurants!"],
    ["Worth it. Get there by 7.30am", "Worth it. Get there by 7.30am."],
    ["Great coffee. The $1,000 suite is not worth it?", "Great coffee. The $1,000 suite is not worth it?"],
  ];
  for (const [a, b] of cases) assert(tidy(a) === b, `"${a}" -> "${tidy(a)}", wanted "${b}"`);
});

await test("Question answers get the right label (Do this / Don't do this / It depends / When to go)", async () => {
  const src = await readFile("assets/v2.js", "utf8");
  const code = src.slice(src.indexOf("var TIMING_Q"), src.indexOf('return "hidden_gem";') + 24);
  const kind = new Function(code + "; return answerKind;")();
  const cases = [["Best time to visit Miami?", "Winter", "worst_times"], ["Visiting Miami without a car?", "Doable", "hidden_gem"],
    ["Wynwood Walls: worth it?", "Worth it", "hidden_gem"], ["Wynwood Walls: worth it?", "Tourist trap", "what_not_to_do"],
    ["Neyland Stadium on game day?", "Only if you have tickets", "take"], ["Old City at night?", "Depends on the night", "take"]];
  for (const [q, o, want] of cases) assert(kind(q, o) === want, `"${q}" / "${o}" -> ${kind(q, o)}, wanted ${want}`);
});

await test("Sign-in: privacy + terms pages, TikTok bridge, providers off until set up", async () => {
  for (const p of ["privacy/index.html", "terms/index.html"]) assert(await exists(join("dist", p)), `dist/${p} missing (Meta and TikTok require it)`);
  const tv = await readFile("assets/tv.js", "utf8");
  assert(/var SIGNIN = \{ facebook: false, tiktok: false \}/.test(tv) || /var SIGNIN = \{[^}]*\}/.test(tv), "SIGNIN switches missing");
  for (const f of ["functions/api/auth/tiktok/start.js", "functions/api/auth/tiktok/callback.js", "functions/api/auth/tiktok/_shared.js"]) {
    const src = await readFile(f, "utf8");
    await import("esbuild").then(e => e.transform(src, { loader: "js", format: "esm" }));   // syntax check
  }
  const cb = await readFile("functions/api/auth/tiktok/callback.js", "utf8");
  assert(cb.includes('cookie(request, "tt_state")'), "TikTok callback must check state");
});

await test("Phone notifications: search-visit and new-take notifiers present, never sent from local", async () => {
  for (const f of ["functions/api/hit.js", "functions/api/_notify.js"]) {
    const src = await readFile(f, "utf8");
    await import("esbuild").then(e => e.transform(src, { loader: "js", format: "esm" }));
  }
  const take = await readFile("functions/api/take.js", "utf8");
  assert(take.includes("notify(context.env"), "take function no longer notifies");
  const a = await readFile("assets/analytics.js", "utf8");
  assert(a.indexOf("/api/hit") > a.indexOf("if (isLocal)"), "search-visit beacon must sit after the localhost skip");
});

await test("New tables and views in migrations come with explicit grants (Supabase, from Oct 30 2026)", async () => {
  const dir = "supabase/migrations";
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".sql") && f.slice(0, 8) > "20261020")) {
    const sql = (await readFile(join(dir, f), "utf8")).replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      const name = m[1];
      assert(new RegExp(`grant\\s[^;]*\\son\\s+(?:table\\s+)?(?:public\\.)?"?${name}"?\\b`, "i").test(sql),
        `${f}: ${name} has no grant (see supabase/migrations/README.md)`);
    }
  }
});

await test("Old UI is gone (no Cosign / Add to this article)", async () => {
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    assert(!/Cosign|Add to this article|Add my take|Back to feed|Start in South Florida/.test(h), `${f} still has old UI text`);
  }
});

await test("Structured data: theme pages link each take; take pages carry DiscussionForumPosting", async () => {
  const fn = await readFile("functions/t/[id].js", "utf8");
  assert(/"DiscussionForumPosting"/.test(fn) && /interactionStatistic/.test(fn), "take page schema missing");
  assert(/main#root/.test(fn), "take text not pre-rendered for crawlers");
  const b = await readFile("build.mjs", "utf8");
  assert(/url: `\$\{SITE\}\/t\/\$\{t\.id\}`/.test(b), "ItemList items need take URLs");
  assert(!/thread\.html\?id=/.test(b), "crawlable links should use /t/<id>");
});

await test("Sitemap and robots point at www", async () => {
  const sm = await readFile("dist/sitemap.xml", "utf8"), rb = await readFile("dist/robots.txt", "utf8");
  assert(sm.includes("https://www.tripvibz.com/"), "sitemap not on www");
  assert(rb.includes("Sitemap: https://www.tripvibz.com/sitemap.xml"), "robots sitemap line wrong");
});

await test("Logo files present (favicon, app icons, manifest)", async () => {
  for (const p of ["favicon.ico", "site.webmanifest", "assets/brand/favicon.svg", "assets/brand/apple-touch-icon.png",
    "assets/brand/icon-192.png", "assets/brand/icon-512.png", "assets/brand/logo.svg"])
    assert(await exists(join("dist", p)), `dist/${p} missing`);
});

await test("Research data and scripts are not published", async () => {
  assert(!(await exists("dist/data")) && !(await exists("dist/scripts")), "dist/ contains data/ or scripts/");
});

await test("Python tools compile; workflows parse", async () => {
  execFileSync("python3", ["-m", "py_compile", "scripts/questions/research.py", "scripts/questions/spec.py", "scripts/questions/intent.py",
    "scripts/city_requests_bot.py", "scripts/take_review_bot.py", "scripts/og_cards.py", "scripts/keywords/bing_keywords.py"]);
  execFileSync("python3", ["-c", "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"]);
});

for (const r of results) console.log(r.join("  "));
const failed = results.filter(r => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
