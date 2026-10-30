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
    // Plain src/href values and every candidate inside a srcset ("… 480w, …").
    for (const m of h.matchAll(/(?:["']|,\s*)(\/assets\/[^"'?#\s,]+)/g))
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
  const dirs = ["supabase/migrations", "supabase/applied-by-hand"];
  for (const dir of dirs) for (const f of (await readdir(dir)).filter(f => f.endsWith(".sql") && f.slice(0, 8) > "20261020")) {
    const sql = (await readFile(join(dir, f), "utf8")).replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      const name = m[1];
      assert(new RegExp(`grant\\s[^;]*\\son\\s+(?:table\\s+)?(?:public\\.)?"?${name}"?\\b`, "i").test(sql),
        `${f}: ${name} has no grant (see supabase/migrations/README.md)`);
    }
  }
});

await test("Local verification: 40-mile rule, presence recorded server-side only, hosting networks never count, no coordinates stored", async () => {
  const src = await readFile("functions/api/locate.js", "utf8");
  const { build } = await import("esbuild");   // bundle so ./_supabase.js and ./_networks.js resolve
  const out = await build({ entryPoints: ["functions/api/locate.js"], bundle: true, write: false, format: "esm", platform: "neutral" });
  const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
  assert(m.band(m.miles(40.7128, -74.0060, 40.7357, -74.1724)) === "near", "Newark should count as near New York");
  assert(m.band(m.miles(40.7128, -74.0060, 39.9526, -75.1652)) === "region", "Philadelphia is region, not near, for New York");
  assert(m.band(m.miles(25.7617, -80.1918, 41.8781, -87.6298)) === "far", "Miami to Chicago is far");
  // Everything the Function sends to the database goes through record_presence (the day-count rule lives there).
  const sent = src.slice(src.indexOf("rpc/record_presence"), src.lastIndexOf("return { cities:"));
  assert(/p_user|p_city|p_near|p_band/.test(sent) && !/lat|lng|latitude|longitude|\bip\b/i.test(sent), "record_presence must get user/city/near/band only — no coordinates or IP");
  assert(!/rest\/v1\/local_checks\?[^`]*method:\s*"POST"/.test(src) && !/on_conflict=user_id,city_id/.test(src), "locate.js must not write local_checks directly (record_presence owns the counting)");
  assert(/isHostingNetwork\(cf\)/.test(src) && /p_near:\s*!hosting/.test(src), "hosting/VPN networks must never count as presence");
  assert((await readFile("functions/api/take.js", "utf8")).includes('from "./locate.js"'), "posting a take should record presence too");
  // The network list: residential and mobile carriers are never on it.
  const n = await import("../functions/api/_networks.js");
  for (const [asn, org] of [[7922, "Comcast Cable Communications"], [21928, "T-Mobile USA"], [22394, "Cellco Partnership DBA Verizon Wireless"], [20115, "Charter Communications"], [7018, "AT&T Services"], [6167, "Verizon Business"], [701, "UUNET"]])
    assert(!n.isHostingNetwork({ asn, asOrganization: org }), `${org} must not be treated as a hosting network`);
  for (const [asn, org] of [[16509, "Amazon.com, Inc."], [14061, "DigitalOcean, LLC"], [13335, "Cloudflare, Inc."], [99999, "Acme VPN Services"]])
    assert(n.isHostingNetwork({ asn, asOrganization: org }), `${org} should be treated as a hosting network`);
});

await test("How-we-verify-locals page: exists, linked, describes the method without the exact thresholds", async () => {
  const h = await readFile("dist/how-we-verify-locals/index.html", "utf8");
  for (const t of ["Verified local", "unverified", "Founding local", "several different days", "VPN", "remove", "What we store", "privacy"])
    assert(h.includes(t), `verify page should mention "${t}"`);
  // The method is public; the numbers that would help someone game it are not.
  assert(!/\b(3|three|five|5) (separate |distinct |different )?days\b/i.test(h) && !/\b(21|14|28|30) days\b/.test(h) && !/\bthree weeks\b/i.test(h),
    "verify page must not state the exact day-count or span thresholds");
  assert(!/near_days|record_presence|asn\b|HOSTING_ASNS/i.test(h), "verify page must not leak implementation names");
  assert((await readFile("dist/sitemap.xml", "utf8")).includes("/how-we-verify-locals/"), "verify page missing from the sitemap");
  for (const f of ["dist/index.html", "dist/about/index.html", "dist/privacy/index.html", "dist/miami/index.html"])
    assert((await readFile(f, "utf8")).includes("/how-we-verify-locals/"), `${f} should link to the verify page`);
  // The badge tiers the scripts draw match the page.
  const v2 = await readFile("assets/v2.js", "utf8");
  assert(/function localBadge\(/.test(v2) && v2.includes("· unverified") && v2.includes(" ✓") && v2.includes("/how-we-verify-locals/"), "v2.js localBadge must draw the three tiers and link the page");
  assert(/select\("user_id,verified,revoked"\)/.test(v2) && !/select\("user_id,near,revoked"\)/.test(v2), "the feed must read verified/revoked, not the raw nearby flag");
  assert((await readFile("thread.html", "utf8")).includes("T2.localBadge("), "thread replies must use the shared badge");
  assert((await readFile("admin.html", "utf8")).includes('rpc("admin_local_checks"'), "admin page must read presence detail through the admin RPC");
});

await test("Secret key goes on the apikey header only (new sb_secret keys are rejected as Bearer)", async () => {
  for (const f of ["functions/api/locate.js", "functions/api/auth/tiktok/callback.js", "functions/api/auth/tiktok/start.js"]) {
    const src = await readFile(f, "utf8");
    assert(!/[Bb]earer[^\n]*SERVICE_ROLE_KEY/.test(src), `${f} sends the secret key as a Bearer token`);
  }
  const { transform } = await import("esbuild");
  const { code } = await transform(await readFile("functions/api/_supabase.js", "utf8"), { loader: "js", format: "esm" });
  const m = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  assert(!m.adminHeaders("sb_secret_x").authorization, "new secret keys must not be sent as Bearer");
  assert(m.adminHeaders("eyJ.legacy").authorization === "Bearer eyJ.legacy", "legacy keys keep working");
});

await test("Unknown pages are real 404s; old take links redirect to /t/<id>", async () => {
  assert(await exists("dist/404.html"), "dist/404.html missing (without it Cloudflare serves the home page for every bad URL)");
  const nf = await readFile("dist/404.html", "utf8");
  assert(/noindex/.test(nf), "404 page must be noindex");
  const t = await readFile("functions/t/[id].js", "utf8");
  assert(/status: 404/.test(t), "/t/<id> must return 404 for missing takes");
  const th = await readFile("functions/thread.js", "utf8");
  assert(/301/.test(th) && th.includes("/t/${id}"), "thread.html?id= should 301 to /t/<id>");
  const robots = await readFile("dist/robots.txt", "utf8");
  assert(!/Disallow: \/thread\.html/.test(robots), "robots.txt must not block thread.html (Google needs to see the redirect)");
});

await test("Every public page has the site footer with About, Privacy and Terms", async () => {
  assert(await exists("dist/about/index.html"), "about page missing");
  for (const f of pages) {
    if (/admin\.html$/.test(f)) continue;
    const h = await readFile(f, "utf8");
    assert((h.match(/class="site-foot"/g) || []).length === 1, `${f}: needs exactly one site footer`);
    for (const href of ["/about/", "/privacy/", "/terms/"]) assert(h.includes(`href="${href}"`), `${f}: footer missing ${href}`);
    assert(!/@miamitake\.com/i.test(h), `${f}: use a tripvibz.com address, not a Miami Take one`);
  }
});

await test("Migrations are named the way the Supabase GitHub integration expects", async () => {
  const files = (await readdir("supabase/migrations")).filter(f => f.endsWith(".sql"));
  const seen = new Set();
  for (const f of files) {
    assert(/^\d{14}_[a-z0-9_]+\.sql$/.test(f), `${f}: name it YYYYMMDDHHMMSS_name.sql (see supabase/migrations/README.md)`);
    const v = f.slice(0, 14);
    assert(!seen.has(v), `${f}: two migrations share version ${v}`);
    seen.add(v);
  }
  assert(files.length >= 23, "the 23 placeholders for already-applied migrations must stay");
});

await test("Stay22: TripVibz's own affiliate ID, never Miami Take's; campaign labels use underscores", async () => {
  const v2 = await readFile("assets/v2.js", "utf8");
  assert(/var STAY22_AID = "tripvibz";/.test(v2), "Stay22 ID should be tripvibz");
  for (const f of pages) assert(!/aid=miamitake|STAY22_AID = "miamitake"/i.test(await readFile(f, "utf8")), `${f}: Miami Take's Stay22 ID`);
  assert(/\.replace\(\/-\/g, "_"\)/.test(v2), "campaign labels must not contain hyphens (Stay22 splits on them)");
  for (const f of ["city.html", "article.html"]) assert((await readFile(f, "utf8")).includes("stay22MapHtml"), `${f}: hotel map missing`);
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

await test("City pages: editors' intro is labeled, never a take; index rule = intro or 3+ takes; nearby links", async () => {
  const intros = JSON.parse(await readFile("data/editorial/intros.json", "utf8"));
  const posts = await api("posts?select=city_id");
  const sm = await readFile("dist/sitemap.xml", "utf8");
  const descs = new Set();
  for (const c of cities) {
    const html = await readFile(join("dist", c.slug, "index.html"), "utf8");
    const n = posts.filter(p => p.city_id === c.id).length;
    const hasIntro = n < 3 && typeof intros[c.slug] === "string";
    if (hasIntro) {
      assert(html.includes('id="tv-editors"') && html.includes("From the TripVibz editors"), `${c.slug}: intro box missing or unlabeled`);
      assert(html.includes("Written by TripVibz, not by locals"), `${c.slug}: intro must say it is not from locals`);
      assert(!/class="take"[^>]*>[^<]*From the TripVibz editors/.test(html), `${c.slug}: intro rendered as a take`);
    } else assert(!html.includes('id="tv-editors"'), `${c.slug}: intro shown on a city with 3+ takes`);
    const indexable = hasIntro || n >= 3;
    assert(/name="robots" content="noindex/.test(html) === !indexable, `${c.slug}: robots tag doesn't match the intro-or-3-takes rule`);
    assert(sm.includes(`/${c.slug}/</loc>`) === indexable, `${c.slug}: sitemap doesn't match the index rule`);
    assert((html.match(/id="tv-nearby"[\s\S]*?<\/nav>/) || [""])[0].split("<a ").length - 1 >= 3, `${c.slug}: fewer than 3 nearby-city links`);
    const d = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
    if (indexable) { assert(d && !descs.has(d), `${c.slug}: description missing or duplicated`); descs.add(d); }
  }
  const city = await readFile("city.html", "utf8");
  assert(city.includes('keep("tv-editors")') && city.includes("EDITORS_HTML"), "city.html must keep the editors' intro after hydration");
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
