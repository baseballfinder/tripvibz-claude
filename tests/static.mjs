// Checks on the built site (dist/) and the repo, run on every pull request
// and merge. No browser; fast. `node build.mjs && node tests/static.mjs`
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const api = async p => (await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY } })).json();
const exists = async p => { try { await stat(p); return true; } catch { return false; } };
async function files(dir, pred = () => true) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p, pred)); else if (pred(p)) out.push(p);
  }
  return out;
}

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
// Cities removed from the site may still be in the database until their migration runs.
let REMOVED = {}; try { REMOVED = JSON.parse(await readFile("data/removed-cities.json", "utf8")); } catch {}
const cities = (await api("cities?select=id,slug&order=sort")).filter(c => !REMOVED[c.slug]);
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

await test("Locals' top 3 restaurants: section pre-rendered on every city page; picker and roll-up wired", async () => {
  for (const c of cities) {
    const h = await readFile(join("dist", c.slug, "index.html"), "utf8");
    assert(h.includes('<section class="eats" id="tv-eats"') && /Where they'd take a friend to eat/.test(h), `${c.slug}: top-3 section missing`);
    assert(h.includes("/how-we-verify-locals/"), `${c.slug}: top-3 section should link to how badges work`);
  }
  const city = (await readFile("city.html", "utf8")) + (await readFile("assets/city.js", "utf8"));
  assert(/from\("city_top_restaurants"\)/.test(city) && /from\("top3_picks"\)\.delete\(\)/.test(city) && /from\("restaurants"\)\.insert\(/.test(city), "city page must read the roll-up and replace the person's list wholesale");
  assert(/created_by: me\.id/.test(city), "new restaurant rows must carry created_by (RLS requires it)");
  assert(/const nameKey = /.test(city) && /\[\^a-z0-9\]\+/.test(city), "client must match names with the same key the database uses");
  const mig = await readFile("supabase/migrations/20261030140000_top3_restaurants.sql", "utf8");
  assert(/jwt_is_verified\(\) and created_by = auth\.uid\(\)/.test(mig) && /jwt_is_verified\(\) and user_id = auth\.uid\(\)/.test(mig), "anonymous sessions must not be able to add restaurants or picks");
  assert(/moderation_guard\(\)/.test(mig) && /moderation_violation\(new\.why\)/.test(mig), "names and whys must go through the content screen");
  assert(/n >= 10 then raise exception 'RATE_LIMITED'/.test(mig), "new restaurant rows must be rate-limited per person");
  assert((await readFile("admin.html", "utf8")).includes('from("restaurants").update(patch)'), "admin page must be able to hide/rename/merge restaurants");
  // The places catalogue: searched from the picker, written only by the bot/service role; a catalogue
  // pick becomes a restaurant row server-side so clients never supply address/phone.
  assert(/rpc\("search_places"/.test(city) && /rpc\("ensure_restaurant_from_place"/.test(city), "picker must search the catalogue and create catalogue picks through the database function");
  const cat = await readFile("supabase/migrations/20261030160000_places_catalog.sql", "utf8");
  assert(/create table if not exists public\.places_catalog/.test(cat) && /grant select on public\.places_catalog to anon, authenticated/.test(cat)
    && /grant select, insert, update, delete on public\.places_catalog to tripvibz_bot/.test(cat) && !/grant[^;]*on public\.places_catalog to authenticated/.test(cat.replace(/grant select on public\.places_catalog to anon, authenticated/, "")),
    "places_catalog: readable by all, writable by the bot and service role only");
  assert(/revoke execute on function public\.ensure_restaurant_from_place\(text\) from public, anon/.test(cat), "ensure_restaurant_from_place must not be callable anonymously");
  assert(/drop view if exists public\.city_top_restaurants;\s*create view/.test(cat), "the roll-up view adds columns in the middle, so it must be dropped and recreated");
  const pop = await readFile("supabase/migrations/20261030180000_places_popularity.sql", "utf8");
  assert(/drop function if exists public\.search_places\(uuid, text\);\s*create function/.test(pop), "search_places changes its return type, so it must be dropped and recreated");
  assert(/c\.review_count desc nulls last,\s*coalesce\(pk\.picks, 0\) desc/.test(pop), "suggestions must sort by review count, then TripVibz picks");
  assert(/rpc\("popular_places"/.test(city) && /Best known in/.test(city), "the picker should offer the best-known places before typing");
  assert(/insert \(city_id, name, neighborhood, created_by\) on public\.restaurants to authenticated/.test(mig), "clients may insert only name/neighborhood on restaurants (address, phone, place_id come from the catalogue)");
  const loader = await readFile("scripts/places_catalog.py", "utf8");
  assert(/overturemaps-us-west-2/.test(loader) && /CDLA-Permissive/.test(loader) && /operating_status/.test(loader), "catalogue loader must read Overture places and note the licence");
  assert((await readFile(".github/workflows/places-catalog.yml", "utf8")).includes("scripts/places_catalog.py"), "monthly catalogue workflow missing");
  // Shown with the list wherever it is drawn: the page script (assets/city.js) and the pre-render (build.mjs eatsHtml).
  for (const f of ["assets/city.js", "build.mjs"]) assert(/<a href="https:\/\/overturemaps\.org\/"[^>]*>Overture Maps<\/a>/.test(await readFile(f, "utf8")), `${f}: Overture attribution missing from the top-3 list`);
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
  for (const f of ["assets/city.js", "article.html"]) assert((await readFile(f, "utf8")).includes("stay22MapHtml"), `${f}: hotel map missing`);
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
  const city = (await readFile("city.html", "utf8")) + (await readFile("assets/city.js", "utf8"));
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

await test("Installable (PWA): manifest, service worker with a build id and an existing shell, offline page, home-screen tags, pwa.js on every page", async () => {
  const m = JSON.parse(await readFile("dist/site.webmanifest", "utf8"));
  assert(m.id === "/" && m.scope === "/" && /^\//.test(m.start_url) && m.display === "standalone", "manifest needs id, scope, start_url and display=standalone");
  assert(m.name && m.short_name && m.theme_color && m.background_color, "manifest needs name, short_name, theme_color, background_color");
  for (const size of ["192x192", "512x512"]) assert(m.icons.some(i => i.sizes === size && !i.purpose), `manifest needs a ${size} any-purpose icon`);
  assert(m.icons.some(i => i.purpose === "maskable" && /maskable/.test(i.src)), "manifest needs a dedicated maskable icon (the full-bleed one gets cropped)");
  for (const i of m.icons) assert(await exists(join("dist", i.src)), `manifest icon ${i.src} missing from dist`);
  const sw = await readFile("dist/sw.js", "utf8");
  const build = (sw.match(/BUILD="([^"]+)"/) || [])[1];
  assert(build && build !== "__BUILD__", "sw.js must carry the build id (lib/sw.js __BUILD__ was not filled in)");
  const shell = JSON.parse((sw.match(/SHELL=(\[[^\]]*\])/) || [])[1] || "null");
  assert(Array.isArray(shell) && shell.includes("/") && shell.includes("/offline/") && shell.some(u => /\/assets\/tv\.js\?v=/.test(u)) && shell.some(u => /\/assets\/fonts\//.test(u)),
    "sw.js shell must precache the home page, the offline page, the versioned scripts and the fonts");
  for (const u of shell) {
    const file = u === "/" ? "index.html" : u.replace(/\?.*$/, "").replace(/\/$/, "/index.html").replace(/^\//, "");
    assert(await exists(join("dist", file)), `sw.js precaches ${u} but dist/${file} does not exist (install would fail)`);
  }
  const swSrc = await readFile("lib/sw.js", "utf8");   // the minifier rewrites the conditions, so read the intent from the source
  assert(/url\.origin !== self\.location\.origin\) return;/.test(swSrc), "lib/sw.js must leave cross-origin requests (Supabase, analytics) alone");
  assert(/url\.pathname\.startsWith\("\/api\/"\)\) return;/.test(swSrc), "lib/sw.js must leave /api/* alone");
  assert(/req\.method !== "GET"\) return;/.test(swSrc), "lib/sw.js must only ever handle GET");
  assert(/\/sw\.js\n\s+! Cache-Control\n\s+Cache-Control: no-cache/.test(await readFile("dist/_headers", "utf8")), "_headers must serve /sw.js with no-cache so deploys reach installed copies");
  const off = await readFile("dist/offline/index.html", "utf8");
  assert(/noindex/.test(off) && /You're offline/.test(off), "offline page must be noindex and say so");
  assert(!(await readFile("dist/sitemap.xml", "utf8")).includes("/offline/"), "offline page must not be in the sitemap");
  const pages = (await files("dist", p => p.endsWith(".html"))).filter(p => !/\/admin\.html$/.test(p));
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    assert(/<script src="\/assets\/pwa\.js\?v=[0-9a-f]+" defer><\/script>/.test(h), `${f}: pwa.js missing`);
    if (h.includes('rel="manifest"')) assert(/apple-mobile-web-app-title/.test(h) && /mobile-web-app-capable/.test(h), `${f}: home-screen metas missing`);
  }
  assert((await readFile("dist/index.html", "utf8")).includes('rel="manifest" href="/site.webmanifest"'), "home page must link the manifest");
});

await test("Worst-times pages answer the search: titled 'Worst time to visit', best/avoid months in the description, summary above the takes; 'by locals' only with takes", async () => {
  const titles = new Set();
  for (const c of cities) {
    const h = await readFile(`dist/${c.slug}/worst-times-to-visit/index.html`, "utf8");
    const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
    assert(!titles.has(title), `${c.slug}: duplicate title ${title}`); titles.add(title);
    if (h.includes('class="cal"')) {
      assert(/^Worst time to visit .+: month-by-month guide \(\d{4}\)$/.test(title), `${c.slug}: title ${title}`);
      assert(/^(Best months|Avoid):/.test(desc) && desc.length <= 170, `${c.slug}: description ${desc}`);
      assert(h.indexOf("cal-sum") > 0 && h.indexOf("cal-sum") < h.indexOf('class="chips"'), `${c.slug}: summary not above the takes`);
    }
  }
  for (const f of pages.filter(f => /\/(what-not-to-do|what-locals-do)\/index\.html$/.test(f))) {
    const h = await readFile(f, "utf8");
    if (/— by locals<\/title>/.test(h)) assert(/class="entry"/.test(h), `${f}: claims "by locals" with no takes`);
  }
});

await test("Cover page during database updates: page loads get a 503 cover while the switch is on; APIs, assets, admin and ?preview=live never do; fails open; /assets/* skips Functions", async () => {
  const mw = await import("../functions/_middleware.js");
  const NOW = Date.parse("2026-11-05T22:00:00Z");
  const sw = row => async () => new Response(JSON.stringify(row ? [row] : []), { status: 200 });
  const req = (path, accept = "text/html,application/xhtml+xml", extra = {}) =>
    new Request("https://www.tripvibz.com" + path, { headers: { accept, ...(extra.cookie ? { cookie: extra.cookie } : {}) }, method: extra.method || "GET" });
  const real = () => new Response("real site", { status: 200, headers: { "content-type": "text/html" } });
  const run = async (request, row, opts = {}) => { mw._resetCache(); return mw.onRequest({ request, next: async () => real() }, { now: NOW, fetchImpl: opts.fetchImpl || sw(row) }); };
  const on = { maintenance: true, until: new Date(NOW + 10 * 60000).toISOString() };

  let r = await run(req("/miami/"), on);
  assert(r.status === 503 && r.headers.get("retry-after") === "300" && r.headers.get("cache-control") === "no-store", "a page load should get the 503 cover with Retry-After");
  const html = await r.text();
  assert(/Back in a few minutes/.test(html) && /http-equiv="refresh"/.test(html) && !/<script/i.test(html), "cover page: wording, self-refresh, no scripts (CSP)");
  assert(r.headers.get("content-security-policy"), "cover page must carry the security headers");
  assert((await run(req("/miami/", "text/html", { method: "HEAD" }), on)).status === 503, "HEAD gets the cover too");

  for (const [path, why, accept] of [["/api/health", "the API", "application/json"], ["/api/health", "the API, even asked for HTML", "text/html"], ["/admin.html", "the admin page", "text/html"],
      ["/assets/v2.js", "assets", "*/*"], ["/sw.js", "the service worker", "*/*"], ["/miami/", "fetch() calls that don't ask for HTML", "application/json"]])
    assert((await run(req(path, accept), on)).status === 200, `${why} must never get the cover`);
  assert((await run(new Request("https://www.tripvibz.com/miami/", { method: "POST", headers: { accept: "text/html" } }), on)).status === 200, "only GET/HEAD are covered");
  const passed = await run(req("/miami/"), { maintenance: false });
  assert(passed.headers.get("content-security-policy") && passed.headers.get("strict-transport-security"), "pages passed through keep the security headers (CSP, HSTS)");

  r = await run(req("/miami/?preview=live"), on);
  assert(r.status === 200 && /tv_live=1/.test(r.headers.get("set-cookie") || ""), "?preview=live shows the real site and sets the one-hour cookie");
  assert((await run(req("/miami/", "text/html", { cookie: "a=b; tv_live=1" }), on)).status === 200, "the preview cookie shows the real site");

  assert((await run(req("/miami/"), { maintenance: false, until: null })).status === 200, "switch off: real site");
  assert((await run(req("/miami/"), { maintenance: true, until: new Date(NOW - 1000).toISOString() })).status === 200, "past its end time: real site, even if the switch was left on");
  assert((await run(req("/miami/"), { maintenance: true, until: null })).status === 503, "on with no end time (manual): covered");
  assert((await run(req("/miami/"), null)).status === 200, "no row: real site");
  assert((await run(req("/miami/"), on, { fetchImpl: async () => new Response("relation does not exist", { status: 404 }) })).status === 200, "table missing: real site");
  assert((await run(req("/miami/"), on, { fetchImpl: async () => { throw new Error("network"); } })).status === 200, "Supabase unreachable: real site (fails open)");

  const routes = JSON.parse(await readFile("dist/_routes.json", "utf8"));
  assert(routes.version === 1 && routes.include.join() === "/*" && routes.exclude.join() === "/assets/*", "dist/_routes.json: Functions on every page, never on /assets/*");
  const mig = await readFile("supabase/migrations/20261105190000_site_status.sql", "utf8");
  assert(/grant select \(id, maintenance, until\) on public\.site_status to anon, authenticated;/.test(mig) && !/grant (insert|update|delete|all)[^;]*to anon/i.test(mig), "site_status: public read only, nobody writes it through the API");
  const wf = await readFile(".github/workflows/maintenance-cover.yml", "utf8");
  assert(/paths: \["supabase\/migrations\/\*\*"\]/.test(wf) && /if: always\(\) && env\.ACTION != 'on'/.test(wf), "workflow: runs on migration merges only and always switches the cover off");
});

await test("Vibes: the list in assets/v2.js matches the migration; recommendations only; tags can't be edited or spoofed; vibe pages indexed from 3 entries", async () => {
  const mig = await readFile("supabase/migrations/20261105200000_vibes.sql", "utf8");
  const seed = [...mig.matchAll(/\('([a-z-]+)',\s*'([^']+)',\s*'(who|mood)',\s*\d+,\s*(true|false),\s*(true|false)\)/g)]
    .map(m => [m[1], m[2], m[3], m[4] === "true", m[5] === "true"].join("|"));
  const v2 = await readFile("assets/v2.js", "utf8");
  const list = [...v2.matchAll(/\{ slug: "([a-z-]+)",\s*label: "([^"]+)",\s*kind: "(who|mood)",\s*takes: (true|false),\s*rests: (true|false) \}/g)]
    .map(m => [m[1], m[2], m[3], m[4] === "true", m[5] === "true"].join("|"));
  assert(seed.length === 12 && seed.join() === list.join(), `vibe list differs between the migration and assets/v2.js:\n${seed.join("\n")}\nvs\n${list.join("\n")}`);
  assert(/var VIBE_KINDS = \{ hidden_gem: 1, take: 1 \}/.test(v2), "only 'Do this' and 'It depends' takes may carry a vibe (client)");
  assert(/t not in \('hidden_gem', 'take'\)/.test(mig), "only 'Do this' and 'It depends' takes may carry a vibe (database)");
  assert(/VIBE_TWO_MAX/.test(mig) && /n >= 40 then raise exception 'RATE_LIMITED'/.test(mig), "two vibes per person per item and a daily cap");
  assert(/new\.city_id := c;/.test(mig), "city_id must come from the tagged item");
  assert(/grant insert \(user_id, vibe, post_id, restaurant_id\), delete on public\.vibe_tags to authenticated;/.test(mig) && !/grant[^;]*update[^;]*vibe_tags/i.test(mig), "tags: insert own columns and delete only, never update");
  assert(/with check \(auth\.uid\(\) = user_id\)/.test(mig), "a tag must carry the tagger's own id");
  const built = await readFile("build.mjs", "utf8");
  assert(/const VIBE_PAGE_INDEX_MIN = 3;/.test(built), "vibe pages go into Google at 3 entries");
  const sitemap = await readFile("dist/sitemap.xml", "utf8");
  const slugs = list.map(x => x.split("|")[0]);
  let pagesSeen = 0;
  for (const c of cities) for (const v of slugs) {
    const f = join("dist", c.slug, v, "index.html");
    if (!(await exists(f))) { assert(!sitemap.includes(`/${c.slug}/${v}/`), `${c.slug}/${v}: in the sitemap with no page`); continue; }
    pagesSeen++;
    const h = await readFile(f, "utf8");
    const n = (h.match(/<li[ >]/g) || []).length;
    assert(n >= 1, `${c.slug}/${v}: empty vibe page`);
    const noindex = /<meta name="robots" content="noindex/.test(h);
    assert(noindex === (n < 3), `${c.slug}/${v}: ${n} entries but noindex=${noindex}`);
    assert(sitemap.includes(`/${c.slug}/${v}/`) === !noindex, `${c.slug}/${v}: sitemap and robots disagree`);
    assert(h.includes(`href="/${c.slug}/${v}/"`) || (await readFile(join("dist", c.slug, "index.html"), "utf8")).includes(`href="/${c.slug}/${v}/"`), `${c.slug}/${v}: not linked from the city page`);
  }
  console.log(`      (${pagesSeen} vibe pages checked)`);
});

await test("Home page: cities with takes come first in the grid; counters say '1 contributor', not '1 contributors'", async () => {
  const h = await readFile("dist/index.html", "utf8");
  const grid = h.slice(h.indexOf('id="needs"'));
  const counts = [...grid.matchAll(/<a class="need"[^>]*data-slug="([^"]+)"[\s\S]*?<span class="n[^"]*">([^<]*)<\/span>/g)].map(m => [m[1], /^(\d+) take/.test(m[2]) ? Number(m[2].match(/^\d+/)[0]) : 0]);
  assert(counts.length === cities.length, `grid shows ${counts.length} of ${cities.length} cities`);
  for (let i = 1; i < counts.length; i++) assert(counts[i - 1][1] >= counts[i][1], `grid order: ${counts[i - 1][0]} (${counts[i - 1][1]}) before ${counts[i][0]} (${counts[i][1]})`);
  for (const [, n, label] of h.matchAll(/<div class="stat"><b>(\d+)<\/b><span>([^<]+)<\/span>/g))
    assert((n === "1") === !/s( open)?$/.test(label) || label === "cities open" && n !== "1", `counter "${n} ${label}"`);
  const page = await readFile("index.html", "utf8");
  assert(/sort\(\(a,b\)=>\(COUNTS\[b\.id\]\|\|0\)-\(COUNTS\[a\.id\]\|\|0\)/.test(page) && /STAT_LABELS/.test(page), "page script: same order as the build, labels follow the numbers");
});

await test("New code comes with tests: the tests-included rule (scripts/tests-included.mjs) on real pull requests", async () => {
  const { check, LABEL } = await import("../scripts/tests-included.mjs");
  const ok = (files, labels) => check(files, labels).ok;
  // Pass: code with a test (#70, #75), no code at all (#76, dependency bumps, robot PRs, wording pages, styles).
  assert(ok(["build.mjs", "tests/static.mjs"]), "#70: build change with a static test");
  assert(ok(["build.mjs", "index.html", "functions/_inline-hashes.js", "tests/static.mjs"]), "#75: home page with a test");
  assert(ok(["lighthouserc.json", "lighthouserc.mobile.json"]), "#76: test settings only");
  assert(ok(["package.json", "package-lock.json", ".github/workflows/tests.yml"]), "dependency bump");
  assert(ok(["supabase/schema.sql"]), "schema snapshot robot PR");
  assert(ok(["assets/og/tulsa.jpg", "data/editorial/intros.json"]), "city-request robot PR");
  assert(ok(["about/index.html", "privacy/index.html", "assets/v2.css"]), "wording pages and styles");
  // Fail: code with no test, or only the coverage table.
  assert(!ok(["functions/api/new.js"]), "a new function with no test");
  assert(!ok(["supabase/migrations/20261201000000_x.sql"]), "a migration with no test");
  assert(!ok(["assets/v2.js", "tests/README.md"]), "the coverage table alone is not a test");
  assert(!ok(["city.html", "assets/v2.css"]), "#74 (an app page) needed a test or the label");
  // The label is the way out, and only that label.
  assert(ok(["city.html", "assets/v2.css"], [LABEL]) && !ok(["city.html"], ["automated"]), `only the "${LABEL}" label skips the rule`);
  const wf = await readFile(".github/workflows/tests-required.yml", "utf8");
  assert(/types: \[opened, synchronize, reopened, labeled, unlabeled\]/.test(wf) && /node scripts\/tests-included\.mjs/.test(wf), "workflow re-runs on label changes and uses the same rule");
  const claude = await readFile("CLAUDE.md", "utf8");
  assert(/tests\/README\.md/.test(claude) && claude.includes(LABEL), "CLAUDE.md states the rule");
  assert(claude.includes("docs/ARCHITECTURE.md") && (await exists("docs/ARCHITECTURE.md")), "CLAUDE.md points to the architecture rules");
});

await test("City search (assets/search.js): states by name, nicknames, Saint/Fort, typos, ranking; /api/near returns only a rounded position and is never cached", async () => {
  const vm = await import("node:vm");
  const ctx = { window: {} }; vm.runInNewContext(await readFile("assets/search.js", "utf8"), ctx);
  const S = ctx.window.TVSearch;
  const C = [
    { slug: "fort-lauderdale", name: "Fort Lauderdale", state: "FL", take_count: 6, lat: 26.12, lng: -80.14 },
    { slug: "miami", name: "Miami", state: "FL", take_count: 4, lat: 25.76, lng: -80.19 },
    { slug: "miami-beach", name: "Miami Beach", state: "FL", take_count: 0 },
    { slug: "st-augustine", name: "St. Augustine", state: "FL", take_count: 0 },
    { slug: "asheville", name: "Asheville", state: "NC", take_count: 0, lat: 35.6, lng: -82.55 },
    { slug: "nashville", name: "Nashville", state: "TN", take_count: 0, lat: 36.16, lng: -86.78 },
    { slug: "knoxville", name: "Knoxville", state: "TN", take_count: 5, lat: 35.96, lng: -83.92 },
    { slug: "new-york", name: "New York", state: "NY", take_count: 0 },
    { slug: "savannah", name: "Savannah", state: "GA", take_count: 0 }
  ];
  const R = [{ slug: "philadelphia", name: "Philadelphia", state: "PA" }, { slug: "tulsa", name: "Tulsa", state: "OK" }];
  const first = q => { const r = S.search(q, C, R).results[0]; return r && r.item.slug; };
  for (const [q, want] of [["florida", "fort-lauderdale"], ["FL", "fort-lauderdale"], ["saint augustine", "st-augustine"], ["st augustine", "st-augustine"],
      ["St. Augustine", "st-augustine"], ["ft lauderdale", "fort-lauderdale"], ["nyc", "new-york"], ["ashville", "asheville"], ["savanah", "savannah"],
      ["nashvile", "nashville"], ["philly", "philadelphia"], ["tuls", "tulsa"], ["miami", "miami"]])
    assert(first(q) === want, `"${q}" -> ${first(q)}, want ${want}`);
  const fl = S.search("Florida", C, R);
  assert(fl.state && fl.state.count === 4 && fl.results.length === 4, "a state name lists its cities");
  assert(fl.results[0].item.slug === "fort-lauderdale" && fl.results[1].item.slug === "miami", "within a state, most takes first");
  assert(S.search("miami", C, R).results.map(r => r.item.slug).join() === "miami,miami-beach", "exact name before longer names");
  const tn = S.search("Tennessee", C, R).results.map(r => r.item.slug).join();
  assert(tn === "knoxville,nashville", `state results by takes: ${tn}`);
  assert(!S.search("xyzzy", C, R).results.length && !S.search("", C, R).results.length, "no match and empty query return nothing");
  assert(S.search("ny", C, R).results.length <= 2, "two letters: no typo guessing");
  assert(S.search("phil", C, R).results.every(r => r.kind === "request"), "cities not open yet come back as requests");
  const near = S.nearest(36.0, -83.9, C, 150, 2).map(x => x.item.slug);
  assert(near[0] === "knoxville" && near[1] === "asheville", `nearest: ${near}`);
  assert(S.stateCounts(C)[0].code === "FL" && S.stateCounts(C)[0].count === 4, "state quick picks: most cities first");
  // /api/near: rounded, per visitor, nothing else.
  const near_ = await import("../functions/api/near.js");
  assert(JSON.stringify(near_.roughPosition({ latitude: "35.96342", longitude: "-83.92071" })) === '{"lat":36,"lng":-83.9}', "position is rounded to 0.1 degree");
  assert(near_.roughPosition({}) === null && near_.roughPosition({ latitude: 0, longitude: 0 }) === null, "no location -> null");
  let r = await near_.onRequestGet({ request: { cf: { latitude: "35.96", longitude: "-83.92" } } });
  assert(r.status === 200 && /no-store/.test(r.headers.get("cache-control")) && Object.keys(await r.json()).join() === "lat,lng", "returns only lat/lng, never cached");
  r = await near_.onRequestGet({ request: {} });
  assert(r.status === 204, "no location -> 204");
  const src = await readFile("functions/api/near.js", "utf8");
  assert(!/fetch\(|SUPABASE|localStorage|notify/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "near.js stores and sends nothing");
  const pg = await readFile("places.html", "utf8");
  assert(/\.search input\{[^}]*font-size:16px/.test(pg) && pg.includes('src="/assets/search.js"'), "Cities page: 16px search box and the shared search script");
});

/* ---------------- info pages follow the features ----------------
   About, Privacy and Terms have to describe the site as it is. These checks
   tie them to the code, so a change that adds an outside service, starts
   storing something new, or retires wording fails here until the pages
   catch up (CLAUDE.md, "Keep the info pages current"). */
await test("Info pages follow the features: Privacy names every outside service and every kind of thing people store; no retired wording anywhere; About lists the main features", async () => {
  const privacy = (await readFile("privacy/index.html", "utf8")).replace(/<[^>]+>/g, " ");
  const about = (await readFile("about/index.html", "utf8")).replace(/<[^>]+>/g, " ");
  // 1. Every outside host the browser may load (CSP) or the server calls (functions/) -> who it is.
  //    A new host fails until it is named on the Privacy page and listed here.
  const SERVICES = [
    [/(^|\.)supabase\.co$/, "Supabase"], [/(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)$/, "Google Analytics"],
    [/(^|\.)clarity\.ms$|^c\.bing\.com$/, "Microsoft Clarity"], [/^accounts\.google\.com$/, "Google handles sign-in"],
    [/(^|\.)stay22\.com$/, "Stay22"], [/^ntfy\.sh$/, "ntfy"], [/(^|\.)(tiktok\.com|tiktokapis\.com)$/, "TikTok"],
    [/^(www\.)?tripvibz\.com$|^schema\.org$/, null]   // the site itself; a vocabulary URL, not a service
  ];
  const sec = await readFile("functions/_security.js", "utf8");
  const fnFiles = (await readdir("functions", { recursive: true })).filter(f => f.endsWith(".js") && !f.includes("_inline-hashes")).map(f => join("functions", f));
  const hosts = new Set([...sec.matchAll(/(?:https|wss):\/\/(?:\*\.)?([a-z0-9.-]+\.[a-z]{2,})/g)].map(m => m[1]));
  for (const f of fnFiles) for (const m of (await readFile(f, "utf8")).matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)) hosts.add(m[1]);
  for (const h of hosts) {
    const hit = SERVICES.find(([re]) => re.test(h));
    assert(hit, `outside service ${h}: name it on the Privacy page ("Who else handles it") and add it to SERVICES in tests/static.mjs`);
    if (hit[1]) assert(privacy.includes(hit[1]), `Privacy page doesn't mention ${hit[1]} (${h})`);
  }
  // 2. Every table that stores something a person entered -> where Privacy says so.
  const COVERED = {
    posts: "your takes", comments: "replies", votes: "votes", question_votes: "answers to city questions",
    top3_picks: "top 3 restaurant picks", restaurants: "top 3 restaurant picks", vibe_tags: "vibes you tag",
    city_tenure: "how long you've lived", local_checks: "Whether you're near a city", contributor_locality: "Rough location when you post",
    email_signups: "If you sign up for email", city_requests: "cities you ask us to add", city_events: "events you suggest",
    claims: "anonymous ID", profiles: "name, profile photo", reviews: "your takes"   // reviews: retired June feature, no new rows
  };
  const sqlFiles = ["supabase/schema.sql", ...(await readdir("supabase/migrations")).map(f => join("supabase/migrations", f))];
  const userTables = new Map();
  for (const f of sqlFiles) {
    const sql = await readFile(f, "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)(?=\n(?:create|alter|comment|grant|revoke|insert|drop|--|$))/gi))
      if (/\b(user_id|author_id|created_by|anon_user_id|email)\b/.test(m[2]) && !userTables.has(m[1])) userTables.set(m[1], f);
  }
  for (const t of ["posts", "votes", "top3_picks", "vibe_tags", "email_signups"]) assert(userTables.has(t), `parser missed ${t}`);
  for (const [t, f] of userTables) {
    assert(COVERED[t], `table ${t} (${f}) stores what people enter: say so on the Privacy page ("What we collect") and add it to COVERED in tests/static.mjs`);
    assert(privacy.includes(COVERED[t]), `Privacy page should mention "${COVERED[t]}" (table ${t})`);
  }
  // Privacy must be dated on or after the newest migration that adds such a table.
  const upd = Date.parse((privacy.match(/Last updated ([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1]);
  const newest = Math.max(...[...userTables.values()].map(f => (f.match(/(\d{8})\d{6}_/) || [])[1]).filter(Boolean).map(d => Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)));
  assert(upd && upd >= newest, `Privacy "Last updated" is older than the newest table that stores user data (${new Date(newest).toISOString().slice(0, 10)})`);
  // 3. Wording retired with the "Where would you take a friend?" hook (Nov 2026), and the founding-local rule.
  const RETIRED = [/what (do )?(tourists|visitors) (get|keep getting) wrong/i, /tell visitors what they get wrong/i, /local take on every city/i,
    /locals, settle this/i, /what locals say about/i, /drives you crazy/i, /what locals know that travel sites/i,
    /first 10 (signed-in )?locals (to post )?(there )?become/i, /\bLIVE IN \{/,
    /\b100 (largest|biggest)\b|\btop[- ]100 (us )?cities\b/i];   // which cities can be requested stays private
  const files = [...pages.filter(f => !f.includes("/assets/")), ...["about/index.html", "privacy/index.html", "terms/index.html", "how-we-verify-locals/index.html",
    "index.html", "city.html", "add.html", "vote.html", "article.html", "places.html", "thread.html", "vibe.html", "assets/v2.js", "assets/city.js", "build.mjs", "scripts/og_cards.py"]];
  for (const f of [...new Set(files)]) {
    const txt = await readFile(f, "utf8");
    for (const re of RETIRED) assert(!re.test(txt), `${f}: retired wording ${re}`);
  }
  // 4. About lists the main features (add one here when a feature ships).
  for (const k of ["Takes.", "Quick questions.", "top 3 restaurants", "Vibes.", "Local badges.", "month-by-month calendar"])
    assert(about.includes(k), `About page doesn't describe: ${k}`);
});

await test("Research data and scripts are not published", async () => {
  assert(!(await exists("dist/data")) && !(await exists("dist/scripts")), "dist/ contains data/ or scripts/");
  for (const f of ["README.md", "CLAUDE.md", "package.json", "docs"]) assert(!(await exists(`dist/${f}`)), `dist/ contains ${f}`);
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
