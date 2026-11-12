// End-to-end tests for every TripVibz feature, run on each pull request and
// merge (.github/workflows/tests.yml) against the freshly built dist/.
//
// Reads go to the live Supabase project, so the pages render real cities,
// questions and takes. Every WRITE (posting, voting, replying, asking for a
// city, anonymous sign-in) is intercepted and answered locally, so tests never
// create rows on the live site.
//
//   node build.mjs && node tests/e2e.mjs            (serves dist/ on :8090)
//   BASE=https://<branch>.tripvibz.pages.dev node tests/e2e.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
let BASE = process.env.BASE;

// ---------- static server for dist/ (mirrors Cloudflare Pages clean URLs) ----------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
  ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
async function serve() {
  const root = "dist";
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (/^\/t\/[0-9a-f-]{36}$/i.test(p)) p = "/thread.html";   // Cloudflare serves /t/<id> via functions/t/[id].js
    let f = join(root, p);
    try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); }
    catch { if (!extname(f)) f += ".html"; }
    try { const b = await readFile(f); res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" }); res.end(b); }
    catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise(r => srv.listen(8090, r));
  return srv;
}

// ---------- fake anonymous session + write interception ----------
const USER_ID = randomUUID();
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER_ID, role: "authenticated", is_anonymous: true, exp, aud: "authenticated" })}.sig`;
const USER = { id: USER_ID, aud: "authenticated", role: "authenticated", is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const SESSION = { access_token: JWT, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "test", user: USER };

const writes = [];
const FAKE_SPOT_ID = "5b0751e0-0000-4000-8000-00000000c0de";
const fakeRows = new Map();   // rows "created" by intercepted writes, served back on read
async function intercept(ctx) {
  await ctx.route(`${SB}/auth/v1/**`, r => {
    const u = r.request().url();
    if (u.includes("/user")) return r.fulfill({ json: USER });
    return r.fulfill({ json: SESSION });
  });
  await ctx.route(`${SB}/rest/v1/**`, async r => {
    const req = r.request(), m = req.method(), url = req.url();
    const headers = { ...req.headers() }; delete headers.authorization;   // reads go out as the anonymous public key
    if (m === "GET") {
      const id = (url.match(/[?&]id=eq\.([0-9a-f-]{36})/) || [])[1];
      if (id && fakeRows.has(id)) {
        const row = fakeRows.get(id);
        return r.fulfill({ json: (headers.accept || "").includes("vnd.pgrst.object") ? row : [row] });
      }
    }
    // Vibes (migration 20261105200000) may not be in the live database yet: answer their reads as an
    // empty, migrated table, so the pages behave the same before and after the migration runs.
    if ((m === "GET" || m === "HEAD") && /\/rest\/v1\/(vibe_tags|post_vibes|restaurant_vibes)\?/.test(url)) return r.fulfill({ json: [] });
    if (url.includes("/rpc/ensure_spot_from_place")) {   // copies a catalogue spot into places: a write, so it never leaves the test
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
      writes.push({ table: "ensure_spot_from_place(rpc)", method: m, body });
      return r.fulfill({ json: FAKE_SPOT_ID });
    }
    if (url.includes("/rpc/email_signup")) {   // never let a test address reach the signup list
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
      writes.push({ table: "email_signup(rpc)", method: m, body });
      return r.fulfill({ status: 204, body: "" });
    }
    if (m === "GET" || m === "HEAD" || url.includes("/rpc/")) return r.continue({ headers });
    let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
    const table = new URL(url).pathname.split("/").pop();
    writes.push({ table, method: m, body });
    const rows = (Array.isArray(body) ? body : [body]).map(x => ({ id: randomUUID(), created_at: new Date().toISOString(),
      author_id: USER_ID, author_verified: false, ups: 0, downs: 0, comment_count: 0, ...x }));
    rows.forEach(x => fakeRows.set(x.id, x));
    const single = (headers.accept || "").includes("vnd.pgrst.object");
    return r.fulfill({ status: m === "POST" ? 201 : 200, json: single ? rows[0] : rows });
  });
  await ctx.route("**/api/take", async r => {
    let body = {}; try { body = JSON.parse(r.request().postData() || "{}"); } catch {}
    writes.push({ table: "posts(api/take)", method: "POST", body });
    const row = { id: randomUUID(), created_at: new Date().toISOString(), author_id: USER_ID, author_verified: false,
      ups: 0, downs: 0, comment_count: 0, ...body };
    fakeRows.set(row.id, row);
    return r.fulfill({ json: { row } });
  });
}

// ---------- tiny test harness ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n")[0]]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const api = async path => (await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } })).json();

// ---------- run ----------
const server = BASE ? null : await serve();
BASE = BASE || "http://localhost:8090";
const browser = await chromium.launch();
// Service workers stay out of the main context so route() keeps seeing every request; the PWA test below
// opens its own context with the worker allowed.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
await intercept(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(`${page.url()}: ${e.message}`));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
const go = async path => { await page.goto(BASE + path, { waitUntil: "networkidle" }); await page.waitForTimeout(800); };

let REMOVED = {}; try { REMOVED = JSON.parse(await readFile("data/removed-cities.json", "utf8")); } catch {}
const cities = (await api("cities?select=id,slug,name&order=sort")).filter(c => !REMOVED[c.slug]);   // removed cities may linger in the database until their migration runs
const qs = await api("questions?select=city_id,sort,prompt&active=eq.true&order=sort");
const lead = slug => { const c = cities.find(x => x.slug === slug); return qs.find(q => q.city_id === c.id); };

await test("Home: hero, city grid, logo, request link", async () => {
  await go("/");
  assert(/Where would you take a friend\?/i.test(await page.textContent("h1")), "headline missing");
  const n = await page.locator("#needs a").count();
  assert(n >= cities.length, `city grid shows ${n} of ${cities.length}`);
  // The build pre-renders the grid and the counters; the script must refresh them in place (not rebuild
  // them) or the photos paint twice and the second paint becomes the page's LCP.
  assert((await page.getAttribute("#needs", "data-hydrated")) === "inplace", `home grid was rebuilt by the script (data-hydrated=${await page.getAttribute("#needs", "data-hydrated")})`);
  assert(await page.locator("#stats .stat").count() === 3, "stats missing");
  assert(/^\d+$/.test((await page.textContent("#stats .stat b")).trim()), "take counter is not a number");
  assert(await page.locator("header .brand-mark").count() === 1, "logo missing in header");
  assert(await page.locator('a[href="/cities/#request"]').count() === 1, "Ask for your city link missing");
  assert(await page.locator('link[rel="icon"]').count() >= 1, "favicon link missing");
});

await test("Photo fallbacks without inline handlers: a broken local copy swaps to its data-fallback, a broken image with data-err is removed", async () => {
  // The head script (build.mjs IMG_ERROR_SCRIPT) replaces the on*= handlers the CSP no longer allows.
  const r = await page.evaluate(() => new Promise(done => {
    const ok = "/assets/brand/mark.svg";
    const a = document.createElement("img"); a.src = "/assets/city/nope-800.webp"; a.srcset = "/assets/city/nope-480.webp 480w"; a.dataset.fallback = ok; a.dataset.err = "remove"; a.id = "fb-a";
    const b = document.createElement("img"); b.src = "/assets/nothing-here.webp"; b.dataset.err = "remove"; b.id = "fb-b";
    const c = document.createElement("img"); c.src = "/assets/nothing-here-2.webp"; c.dataset.err = "hide"; c.id = "fb-c";
    document.body.append(a, b, c);
    setTimeout(() => done({
      a: a.getAttribute("src"), aSet: a.getAttribute("srcset"), aIn: !!document.getElementById("fb-a"),
      bIn: !!document.getElementById("fb-b"), cHidden: c.style.visibility
    }), 1500);
  }));
  assert(r.a === "/assets/brand/mark.svg" && r.aSet === "" && r.aIn, `broken tile did not swap to its fallback: ${JSON.stringify(r)}`);
  assert(!r.bIn, "broken image with data-err=remove is still in the page");
  assert(r.cHidden === "hidden", "broken avatar with data-err=hide is still visible");
});

await test("How we verify locals: page renders, badge tiers listed, reachable from the footer", async () => {
  await go("/how-we-verify-locals/");
  assert(/How we verify locals/.test(await page.textContent("h1")), "headline missing");
  const tiers = await page.locator(".tiers li").count();
  assert(tiers >= 4, `expected the badge tiers listed, found ${tiers}`);
  assert(await page.locator('footer a[href="/how-we-verify-locals/"]').count() === 1, "footer link to the page missing");
  await go("/miami/");
  assert(await page.locator('footer a[href="/how-we-verify-locals/"]').count() === 1, "footer link missing on city pages");
});

await test("Cities page: grid, search, request-a-city", async () => {
  await go("/cities/");
  assert(await page.locator(".city-card").count() >= cities.length, "city cards missing");
  assert((await page.getAttribute("#live-grid", "data-hydrated")) === "inplace", `cities grids were rebuilt by the script (data-hydrated=${await page.getAttribute("#live-grid", "data-hydrated")})`);
  assert(await page.locator("#soon-label:not([hidden])").count() + await page.locator("#live-label:not([hidden])").count() >= 1, "section labels hidden");
  await page.fill("#search", "zzzz");
  assert(/No TripVibz city matches/.test(await page.textContent("#live-grid")), "empty search state missing");
  assert(/ask for a new one/i.test(await page.textContent("#sugg")), "no-match suggestion should point to asking for a city");
  await page.fill("#search", "");
  await page.fill("#req-q", "tuls");
  await page.waitForTimeout(200);
  assert(/Tulsa/.test(await page.textContent("#req-list")), "Tulsa not offered for request");
  await page.evaluate(() => { navigator.share = undefined; navigator.clipboard.writeText = async () => {}; });
  await page.click('[data-ask="tulsa"]');
  await page.waitForTimeout(500);
  assert(writes.some(w => w.table === "city_requests" && w.body.city_slug === "tulsa"), "ask did not send a request");
  assert(await page.locator('[data-ask="tulsa"][disabled]').count() === 1, "button did not switch to Asked");
});

await test("Cities page search: 16px box, states and nicknames, typos, suggestions with Enter, ask from the list, quick picks (near you, recent, states)", async () => {
  // "Near you" reads functions/api/near.js; the local server has no Functions, so answer it here (Knoxville).
  await page.route("**/api/near", r => r.fulfill({ json: { lat: 36.0, lng: -83.9 } }));
  await page.addInitScript(() => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("tv_recent_cities", JSON.stringify(["miami"])); } } catch (e) {} });
  await go("/cities/");
  await page.waitForTimeout(600);
  assert(await page.$eval("#search", e => parseFloat(getComputedStyle(e).fontSize)) >= 16, "search text under 16px makes iPhones zoom in");
  assert(await page.getAttribute("#search", "role") === "combobox" && await page.getAttribute("#search", "enterkeyhint") === "go", "search box should be a combobox with a Go key");
  const chips = (await page.textContent("#quick")).replace(/\s+/g, " ");
  assert(/Near you: Knoxville/.test(chips) && /Miami/.test(chips) && /Florida \d+/.test(chips), `quick picks: ${chips}`);
  // Every quick pick fits inside the row (they wrap instead of running off the edge), on a phone and on a laptop.
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
    const cut = await page.$$eval("#quick .qchip", (els) => { const box = els[0].parentElement.getBoundingClientRect();
      return els.filter(e => { const r = e.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; }).map(e => e.textContent.trim()); });
    assert(!cut.length, `quick picks cut off at ${width}px: ${cut.join(", ")}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // A state by name filters to its cities, with a scope row first.
  await page.fill("#search", "florida"); await page.waitForTimeout(300);
  const fl = (await api("cities?select=slug,state")).filter(c => c.state === "FL" && cities.some(x => x.slug === c.slug)).length;
  assert(new RegExp(`All ${fl} cities in Florida`).test(await page.textContent("#sugg li:first-child")), "state scope row missing");
  assert(await page.locator("#live-grid .city-card, #soon-grid .city-card").count() === fl, "grid should show only Florida cities");
  assert(await page.getAttribute('#quick [data-state="Florida"]', "aria-pressed") === "true", "Florida chip should show as on");
  // Nicknames, Saint/St. and typos.
  for (const [q, name] of [["nyc", "New York"], ["saint augustine", "St. Augustine"], ["ashville", "Asheville"], ["savanah", "Savannah"]]) {
    await page.fill("#search", q); await page.waitForTimeout(250);
    assert((await page.textContent("#sugg li:first-child")).includes(name), `"${q}" should suggest ${name} first, got: ${await page.textContent("#sugg li:first-child")}`);
  }
  // A city that isn't open yet can be asked for straight from the list.
  await page.evaluate(() => { navigator.share = undefined; navigator.clipboard.writeText = async () => {}; });
  await page.fill("#search", "philly"); await page.waitForTimeout(250);
  assert(/Philadelphia/.test(await page.textContent("#sugg")) && await page.locator('#sugg [data-ask="philadelphia"]').count() === 1, "Philadelphia should be offered to ask for");
  await page.click('#sugg [data-ask="philadelphia"]'); await page.waitForTimeout(500);
  assert(writes.some(w => w.table === "city_requests" && w.body.city_slug === "philadelphia"), "asking from the list did not send a request");
  assert(await page.locator('#sugg [data-ask="philadelphia"][disabled]').count() === 1, "the list should switch to Asked");
  // Enter opens the top suggestion; the clear button empties the box.
  await page.fill("#search", "ashville"); await page.waitForTimeout(250);
  await page.click("#sclear"); assert((await page.inputValue("#search")) === "" && await page.locator("#sugg[hidden]").count() === 1, "clear button");
  await page.fill("#search", "ashville"); await page.waitForTimeout(250);
  await Promise.all([page.waitForURL(/\/asheville\/$/, { timeout: 8000 }), page.keyboard.press("Enter")]);
  // Opening a city page remembers it for the quick picks.
  await page.waitForFunction(() => (localStorage.getItem("tv_recent_cities") || "").includes("asheville"), null, { timeout: 8000 }).catch(() => {});
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem("tv_recent_cities") || "[]"));
  assert(rec[0] === "asheville", `recently viewed not recorded: ${JSON.stringify(rec)}`);
  await page.unroute("**/api/near");
});

for (const slug of ["nashville", "knoxville", "miami"]) {
  await test(`City feed (${slug}): hero photo, lead question, sections, no old add button`, async () => {
    await go(`/${slug}/`);
    assert(/^Know .+\?$/.test((await page.textContent("h1")).trim()), "headline should read \"Know <City>?\"");
    assert(/where to go, what to skip, when to come$/.test(await page.title()), `the tab should keep the built title after load: ${await page.title()}`);
    const w = await page.evaluate(() => { const i = document.querySelector(".city-hero"); return i ? i.naturalWidth : 0; });
    assert(w > 0, "hero photo did not load");
    assert((await page.textContent(".qcard .qp")).trim() === lead(slug).prompt, "lead question is not the first active question");
    assert(await page.locator(".qcard a.qopt").count() >= 2, "question options missing");
    const hasTakes = (await page.locator(".feed .take").count()) > 0;
    if (hasTakes) {
      // Three honest tiers, never a bare "Local" for a sign-in alone: ✓ (verified presence),
      // "· unverified" (signed in, not yet seen around town), or "Unverified" (anonymous/revoked).
      const badges = await page.locator(".feed .take .who .bdg:not(.found)").allTextContents();
      assert(badges.length, "take cards show no badge");
      for (const b of badges) assert(/✓$|· unverified$|^Unverified$|^Regular visitor/.test(b.trim()), `badge "${b}" is not one of the three tiers`);
      const link = page.locator(".feed .take .who a.bdg").first();
      if (await link.count()) assert((await link.getAttribute("href")) === "/how-we-verify-locals/", "local badge should link to the verification page");
    }
    // Filters only once there is enough to filter (10+ takes); small cities stay uncluttered.
    const many = (await page.locator(".feed .take").count()) >= 10;
    assert(await page.locator("[data-sec]").count() === (many ? 4 : 0), many ? "section chips missing" : "filter chips should be hidden under 10 takes");
    assert(await page.locator("details.nt:not([open])").count() === 1, "new-topic box should start collapsed");
    assert(await page.locator(".fab").count() === 0, "old \"What do tourists get wrong\" button is back");
    // One section at a time: four tabs, Takes open, the rest hidden until tapped; the hash deep-links a tab.
    assert(await page.locator('.tabs [role="tab"]').count() === 4, "city page should have four tabs");
    assert(await page.isVisible("#panel-takes") && !(await page.isVisible("#panel-eat")) && !(await page.isVisible("#panel-when")) && !(await page.isVisible("#panel-guide")), "only the Takes panel should show at first");
    assert(await page.locator(".hero-band h1").count() === 1 && await page.isVisible(".cta-bar a.cta-btn"), "title should sit on the hero and the Add-your-take bar should show");
    assert((await page.getAttribute(".cta-bar a.cta-btn", "href")) === `/${slug}/add/`, "Add your take should open the add page");
    await page.click('[data-tab="eat"]');
    assert(await page.isVisible("#tv-eats") && !(await page.isVisible("#panel-takes")), "Eat tab should swap the panels");
    assert((await page.evaluate(() => location.hash)) === "#eat", "the tab should be in the URL hash");
    assert((await page.getAttribute('[data-tab="eat"]', "aria-selected")) === "true", "Eat tab should be selected");
    assert(/top 3/.test(await page.textContent(".cta-bar a.cta-btn")) && (await page.getAttribute(".cta-bar a.cta-btn", "href")) === "#top3", "on Eat the bar should ask for a top 3");
    await page.click('[data-tab="takes"]');
    assert(await page.isVisible("#panel-takes") && (await page.evaluate(() => location.hash)) === "", "Takes tab should clear the hash");
  });
}

await test("Share preview: question card image, title and size tags", async () => {
  const html = await (await fetch(`${BASE}/nashville/`)).text();
  const img = (html.match(/property="og:image" content="([^"]+)"/) || [])[1] || "";
  assert(/\/assets\/og\/nashville\.jpg$/.test(img), `og:image is ${img}`);
  assert(img.startsWith("https://www.tripvibz.com/"), "og:image must use www");
  assert(html.includes('property="og:image:width" content="1200"'), "og:image:width missing");
  assert(html.includes(lead("nashville").prompt.replace(/'/g, "&#39;").slice(0, 30)) || html.includes(lead("nashville").prompt.slice(0, 30)), "og:title is not the lead question");
});

await test("Vote: one tap records the vote and shows results + why box", async () => {
  await go("/nashville/");
  const href = await page.getAttribute(".qcard a.qopt >> nth=0", "href");
  await go(href);
  assert(writes.some(w => w.table === "question_votes"), "vote was not sent");
  assert(await page.locator("#why").count() === 1, "why box missing");
  await page.click("#share-q");
  const fb = await page.getAttribute('#sharesheet [data-m="facebook"]', "href");
  assert(fb && decodeURIComponent(fb).includes("https://www.tripvibz.com/nashville/vote/?q="), "question share link wrong");
  await page.click("#sharesheet .sheet-x");
});

await test("Add page = the city's questions: every active question as a card with options, one tap answers (recorded) and opens a why box, a sentence posts a take tied to the question, the card then shows it; place search available in the why box; progress counts up", async () => {
  await go("/nashville/add/");
  const qsLive = await api("questions?select=id,prompt,options&city_id=eq." + encodeURIComponent(cities.find(c => c.slug === "nashville").id) + "&active=eq.true&order=sort");
  assert(qsLive.length >= 1, "Nashville has no active questions to test with");
  // The simple layout: the site nav, one card per question, no free-text composer.
  assert(await page.locator('header.nav .nav-links a[href="/cities/"]').count() === 1, "add page should carry the site nav (Cities)");
  assert(await page.locator("#qlist .qa").count() === qsLive.length, `one card per active question (${await page.locator("#qlist .qa").count()} vs ${qsLive.length})`);
  assert(await page.locator("#take, .segs, [data-kind], .bigbtn, .kinds").count() === 0, "the free-text composer must not be on the add page");
  assert(/0 of \d+ answered/.test(await page.textContent(".progress")), "progress should start at 0");
  const first = page.locator("#qlist .qa").first();
  const firstPrompt = (await first.locator("h2").textContent()).trim();
  const q0 = qsLive.find(q => q.prompt === firstPrompt) || qsLive[0];
  assert(await first.locator(".qopt").count() === q0.options.length, "every option should be a pill");
  assert(await first.locator(".why-box").count() === 0, "the why box waits for an answer");
  // One tap: the vote is sent, results show, the why box opens.
  const before = writes.length;
  await first.locator(".qopt").first().click(); await page.waitForTimeout(400);
  const vote = writes.slice(before).find(w => w.table === "question_votes");
  assert(vote && vote.body.question_id === q0.id && vote.body.option_id === q0.options[0].id, `the tap should record the vote: ${JSON.stringify(writes.slice(before))}`);
  assert(await first.locator('.qopt[aria-pressed="true"]').count() === 1 && /vote/.test(await first.locator(".tally").textContent()), "picked option should fill and a tally should show");
  assert(await first.locator(".why-box").count() === 1 && /1 of \d+ answered/.test(await page.textContent(".progress")), "a why box should open and progress should count the answer");
  // The optional place search lives in the why box (16px, so iPhones don't zoom).
  await first.locator(".where summary").click();
  assert(await page.$eval("#place-q", e => parseFloat(getComputedStyle(e).fontSize)) >= 16, "place search under 16px makes iPhones zoom in");
  await page.route("**/rest/v1/rpc/search_take_places", r => r.fulfill({ json: [] }));
  await page.fill("#place-q", "Lower Broadway"); await page.waitForTimeout(500);
  await page.click("#pl-sugg .pl-opt.typed");
  await page.unroute("**/rest/v1/rpc/search_take_places");
  assert(/Not on the map/.test(await page.textContent("#where")), "a typed place should say it isn't on the map");
  // Too short a why is refused in place; a sentence posts a take tied to the question.
  await page.fill("[data-why]", "TEST");
  await page.click("[data-post-why]"); await page.waitForTimeout(300);
  assert(await page.locator(".qa .err").count() === 1 && !writes.slice(before).some(w => w.table.startsWith("posts")), "a four-letter why must not post");
  await page.fill("[data-why]", "TEST the sidewalks do not move on a CMA Fest weekend, go a week later");
  await page.click("[data-post-why]"); await page.waitForTimeout(1200);
  const sent = writes.slice(before).filter(w => w.table.startsWith("posts")).pop();
  assert(sent, "take was not sent");
  const label = q0.options[0].label.toLowerCase();
  assert(sent.body.question_id === q0.id && sent.body.place_label === "Lower Broadway" && !sent.body.place_id && sent.body.title.toLowerCase().includes(label) && /CMA Fest/.test(sent.body.title),
    `the take should carry the question, the picked answer and the sentence: ${JSON.stringify(sent.body)}`);
  assert(await first.locator(".mine-take").count() === 1 && await first.locator(".why-box").count() === 0, "the card should now show the posted take instead of the why box");
  // "Just the answer is fine" closes the box on another question without posting.
  const second = page.locator("#qlist .qa").nth(1);
  if (await second.count()) {
    await second.locator(".qopt").first().click(); await page.waitForTimeout(300);
    const n = writes.length; await second.locator("[data-skip-why]").click(); await page.waitForTimeout(200);
    assert(await second.locator(".why-box").count() === 0 && writes.length === n, "skipping the why should close the box and send nothing");
  }
  // Anonymous: a quiet sign-in nudge, never a wall.
  assert(await page.locator("#nudge-signin").count() === 1, "anonymous visitors should see the sign-in nudge");
});

await test("Add page: ?kind= from a topic page puts matching questions first; suggesting a question goes to review as a pending take with a topic", async () => {
  await go("/nashville/add/?kind=worst_times");
  const prompts = await page.locator("#qlist .qa h2").allTextContents();
  if (prompts.some(p => /time to visit|worst time|best time/i.test(p))) assert(/time to visit|worst time|best time/i.test(prompts[0]), `a timing question should lead for ?kind=worst_times: ${prompts.join(" | ")}`);
  await page.click("#nt summary");
  await page.fill("#nt-text", "TEST this is not a question");
  await page.click("#nt-send"); await page.waitForTimeout(300);
  assert(await page.locator("#nt .err").count() === 1, "a statement should be refused as a suggestion");
  const before = writes.length;
  await page.fill("#nt-text", "TEST Is the Broadway honky-tonk crawl worth one night, or skip it?");
  await page.click("#nt-send"); await page.waitForTimeout(1200);
  const sent = writes.slice(before).find(w => w.table.startsWith("posts"));
  assert(sent && sent.body.topic && /honky-tonk/.test(sent.body.title), `the suggestion should go in as a take with a topic (review): ${JSON.stringify(sent && sent.body)}`);
  assert(/we'll look at it/i.test(await page.textContent("#root")), "the person should be thanked");
});

await test("Vibes: a custom take (admin reply link) offers up to two vibes (none on warnings), saved with the take; a take card takes a vibe in one tap", async () => {
  await go("/knoxville/add/?kind=hidden_gem&text=" + encodeURIComponent("TEST take your parents to the Sunsphere at golden hour, then dinner in Market Square"));
  assert(await page.locator('[data-kind="hidden_gem"][aria-pressed="true"]').count() === 1, "'Do this' should be the default kind");
  assert(await page.locator("#vibe-sect").count() === 1, "vibe picker missing on a 'Do this' take");
  await page.click('[data-pick-vibe="t:date-night"]');
  await page.click('[data-pick-vibe="t:the-parents"]');
  await page.click('[data-pick-vibe="t:solo"]');
  assert(await page.locator('#vibe-sect [aria-pressed="true"]').count() === 2, "more than two vibes could be picked");
  await page.click('#vibe-sect [data-more-vibes]');
  assert(await page.locator('[data-pick-vibe="t:loud-and-late"]').count() === 1 && await page.locator('[data-pick-vibe="t:dressy"]').count() === 0, "mood vibes: 'Dressy' is for restaurants only");
  await page.click('[data-kind="what_not_to_do"]');
  assert(await page.locator("#vibe-sect").count() === 0, "warnings must not take a vibe");
  await page.click('[data-kind="hidden_gem"]');
  assert(await page.locator('#vibe-sect [aria-pressed="true"]').count() === 2, "picked vibes should survive switching kinds");
  const before = writes.length;
  await page.click("#post-anon");
  await page.waitForTimeout(1500);
  const vt = writes.slice(before).find(w => w.table === "vibe_tags" && w.method === "POST");
  assert(vt, "vibes were not saved with the take");
  const rows = Array.isArray(vt.body) ? vt.body : [vt.body];
  assert(rows.length === 2 && rows.every(r => r.post_id && !r.restaurant_id && !r.city_id) && rows.map(r => r.vibe).sort().join() === "date-night,the-parents", "wrong vibe rows: " + JSON.stringify(rows));

  await go("/knoxville/");
  const card = page.locator('.take:has([data-vibe-more])').first();
  assert(await card.count() === 1, "no vibe button on a 'Do this' take card");
  assert(await page.locator('.take:has(.tk-kind.k-dont) [data-vibe-more]').count() === 0, "a 'Don't do this' card offered a vibe");
  await card.locator("[data-vibe-more]").click();
  await card.locator('[data-vibe="first-timer"]').click();
  await page.waitForTimeout(600);
  assert(writes.some(w => w.table === "vibe_tags" && w.method === "POST" && w.body.vibe === "first-timer" && w.body.post_id), "tapping a vibe on a take did not save it");
  assert(await card.locator('[data-vibe="first-timer"][aria-pressed="true"]').count() === 1, "your vibe should show as yours");
});

await test("Sign in with Google: the add page's sign-in nudge opens the sign-in box", async () => {
  await go("/nashville/add/");
  await page.click("#nudge-signin");
  await page.waitForTimeout(800);
  assert(await page.isVisible("#loginmodal"), "sign-in box did not open");
});

await test("Topic page: new take cards, starters open the add page, calendar on worst times", async () => {
  await go("/nashville/what-not-to-do/");
  assert(/What not to do in Nashville/.test(await page.textContent("h1")), "headline missing");
  assert(await page.locator(".takes .chips a.chip").count() === 4, "section chips (same as the city page) missing");
  assert(await page.locator(".takes .chips a.chip[aria-current=\"page\"]").count() === 1, "current section should be selected");
  const s = await page.getAttribute(".qcard a.qopt >> nth=0", "href");
  assert(s && s.startsWith("/nashville/add/?kind=what_not_to_do"), "starter link wrong");
  assert(!(await page.content()).includes("Cosign"), "old Cosign UI is back");
  await go("/nashville/worst-times-to-visit/");
  assert(await page.locator(".cal-months .m").count() === 12, "month calendar missing");
  assert(/Researched by the TripVibz editors/.test(await page.textContent(".cal")), "calendar must be labeled as editors' research, not locals");
  // Pre-rendered NOAA table survives hydration (article.html re-renders #root).
  await page.waitForSelector(".cal-months .m");
  assert(await page.locator("#tv-climate tbody tr").count() === 12, "weather-by-month table lost after the page loaded");
  assert(await page.locator("#tv-climate").count() === 1, "weather table rendered twice");
  // Google renders scripts: hydration must not swap the build's search title for a generic one.
  await page.waitForTimeout(300);
  assert(/weather by month/.test(await page.title()), `topic page title replaced on load: ${await page.title()}`);
  const sel = page.locator('.cal-months .m[aria-pressed="true"] .mn');
  assert(await sel.count() === 1 && await sel.evaluate(e => getComputedStyle(e).color !== getComputedStyle(e.closest("button")).backgroundColor), "selected month label invisible");
});

await test("City page: When-to-go strip links to the month-by-month calendar", async () => {
  await go("/nashville/#when");   // deep link straight to the When-to-go tab
  await page.waitForSelector("a.when", { timeout: 8000 });
  assert((await page.getAttribute('[data-tab="when"]', "aria-selected")) === "true" && !(await page.isVisible("#panel-takes")), "#when should open the When-to-go tab");
  assert(await page.locator(".when-strip span").count() === 12, "month strip should have 12 cells");
  assert((await page.getAttribute("a.when", "href")) === "/nashville/worst-times-to-visit/", "strip should link to the calendar");
  const best = await page.textContent(".when-t .wl:first-child");
  assert(/Best/i.test(best) && /·\s*\S/.test(best), "Best line should name the reason (e.g. 'Mar–May · Spring')");
});

await test("Where is this? (custom take via an admin reply link): search spots and restaurants, pick one, and the take is pinned to it (catalogue spots copied in server-side)", async () => {
  await page.route("**/rest/v1/rpc/search_take_places", r => r.fulfill({ json: [
    { ref: "p:a0000000-0000-0000-0000-000000000001", name: "Market Square", kind: "spot", category: "plaza", detail: "Downtown Knoxville", lat: 35.9656, lng: -83.9198, takes: 1 },
    { ref: "c:ov-msfm", name: "Market Square Farmers Market", kind: "spot", category: "farmers_market", detail: "60 Market Sq", lat: 35.965, lng: -83.9195, takes: 0 },
    { ref: "c:ov-mkt", name: "Market House Restaurant", kind: "eat", category: "restaurant", detail: "33 Market Sq", lat: 35.9658, lng: -83.9195, takes: 0 }
  ] }));
  await go("/knoxville/add/?kind=hidden_gem&text=" + encodeURIComponent("TEST the farmers market on Saturday mornings is the best hour in town"));
  assert(await page.locator("#take").count() === 1 && await page.locator("#qlist").count() === 0, "a reply link opens the composer, not the questions");
  assert(await page.$eval("#place-q", e => parseFloat(getComputedStyle(e).fontSize)) >= 16, "place search under 16px makes iPhones zoom in");
  await page.fill("#place-q", "market"); await page.waitForTimeout(500);
  const opts = await page.locator("#pl-sugg .pl-opt").allTextContents();
  assert(opts.length === 4 && /Market Square.*1 take here/.test(opts[0]) && /Restaurant or bar/.test(opts[2]) && /Use “market”/.test(opts[3]), `suggestions: ${opts.join(" / ")}`);
  await page.click('#pl-sugg [data-sugg="1"]');
  assert(/Market Square Farmers Market/.test(await page.textContent("#where")) && /On the Guide map/.test(await page.textContent("#where")), "picked spot should show as on the map");
  if (await page.locator('[data-tenure="10+"]').count()) await page.click('[data-tenure="10+"]');
  const before = writes.length;
  await page.click("#post-anon"); await page.waitForTimeout(1500);
  const mine = writes.slice(before);
  const copy = mine.find(w => w.table === "ensure_spot_from_place(rpc)"), take = mine.find(w => w.table.startsWith("posts"));
  assert(copy && copy.body.p_place === "ov-msfm", `the catalogue spot should be copied in server-side: ${JSON.stringify(mine)}`);
  assert(take && take.body.place_id === FAKE_SPOT_ID && take.body.place_label === "Market Square Farmers Market", `take not pinned: ${JSON.stringify(take && take.body)}`);
  // A spot TripVibz already has needs no copy: its id goes straight on the take; "Change" clears it.
  await go("/knoxville/add/?kind=hidden_gem&text=" + encodeURIComponent("TEST Market Square at lunch on a weekday is calm and easy"));
  await page.fill("#place-q", "market"); await page.waitForTimeout(500);
  await page.click('#pl-sugg [data-sugg="0"]');
  await page.click("#pl-change");
  assert(await page.locator("#place-q").count() === 1, "Change should bring the search back");
  await page.fill("#place-q", "market"); await page.waitForTimeout(500); await page.click('#pl-sugg [data-sugg="0"]');
  if (await page.locator('[data-tenure="10+"]').count()) await page.click('[data-tenure="10+"]');
  const b2 = writes.length;
  await page.click("#post-anon"); await page.waitForTimeout(1500);
  const w2 = writes.slice(b2);
  assert(!w2.some(w => w.table === "ensure_spot_from_place(rpc)") && w2.find(w => w.table.startsWith("posts")).body.place_id === "a0000000-0000-0000-0000-000000000001", "a TripVibz spot goes straight on the take");
  await page.unroute("**/rest/v1/rpc/search_take_places");
});

await test("Guide tab (replaces Stay): map of take spots and top restaurants loads only when opened, top 3 with how many people picked each and their reviews, spots with their takes, hotels last; old #stay links land on it; the lists stand if the map fails", async () => {
  // The pins (posts.place_id) arrive with migration 20261107170000; answer as a migrated database would, and keep map tiles local.
  const SPOTS = { "Market Square": ["a0000000-0000-0000-0000-000000000001", 35.96561, -83.91984], "Neyland Stadium": ["a0000000-0000-0000-0000-000000000002", 35.95499, -83.92513], "Old City": ["a0000000-0000-0000-0000-000000000003", 35.97049, -83.91847] };
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  let tiles = 0, mapJs = 0;
  await page.route("**/rest/v1/posts?*", async r => {
    const headers = { ...r.request().headers() }; delete headers.authorization;   // as intercept() does: reads go out with the public key
    const res = await r.fetch({ headers }); const rows = await res.json();
    (Array.isArray(rows) ? rows : []).forEach(p => { const s = SPOTS[p.place_label]; if (s) p.place_id = s[0]; }); return r.fulfill({ response: res, json: rows }); });
  await page.route("**/rest/v1/places?*", r => r.fulfill({ json: Object.entries(SPOTS).map(([name, [id, lat, lng]]) => ({ id, name, lat, lng, category: "spot" })) }));
  await page.route("https://tile.openstreetmap.org/**", r => { tiles++; return r.fulfill({ body: PNG, contentType: "image/png" }); });
  let guideJs = 0;
  const countMap = q => { if (q.url().includes("/assets/leaflet-")) mapJs++; if (q.url().includes("/assets/guide.js")) guideJs++; };
  page.on("request", countMap);
  try {
  await go("/knoxville/");
  assert(await page.locator('.tabs [data-tab="guide"]').count() === 1 && await page.locator('[data-tab="stay"]').count() === 0, "Guide tab should replace Stay");
  assert(mapJs === 0 && tiles === 0 && guideJs === 0, "the Guide script, map library and tiles must not load until the Guide is opened");
  await page.click('[data-tab="guide"]'); await page.waitForTimeout(1500);
  assert((await page.evaluate(() => location.hash)) === "#guide" && await page.isVisible("#tv-guide"), "Guide tab should open its panel and set #guide");
  assert(mapJs > 0 && tiles > 0 && await page.locator("#tv-guide .leaflet-container").count() === 1, `map didn't load (script ${mapJs}, tiles ${tiles})`);
  const pins = { eat: await page.locator("#tv-guide .g-pin.eat").count(), spot: await page.locator("#tv-guide .g-pin.spot").count() };
  const eats = await page.locator("#tv-guide .g-eat").count();
  assert(pins.spot === 3 && pins.eat === eats && eats <= 3, `pins: ${JSON.stringify(pins)}, restaurants listed: ${eats}`);
  if (eats) {
    assert(/Picked by \d+ (person|people)/.test(await page.textContent("#tv-guide .g-eat .g-count")), "each restaurant should say how many people picked it");
    const reviews = await page.locator("#tv-guide .g-eat .g-reviews li").count();
    const why = await api(`top3_picks?select=why&city_id=eq.${cities.find(c => c.slug === "knoxville").id}&why=not.is.null`);
    assert(reviews >= Math.min(1, why.length), "people's reviews should show under each restaurant");
  }
  const spotNames = await page.locator("#tv-guide .g-spot .g-name").allTextContents();
  assert(spotNames.length === 3 && spotNames.includes("Neyland Stadium") && await page.locator('#tv-guide .g-spot .g-takes a[href^="/t/"]').count() >= 3, `spots: ${spotNames}`);
  assert(await page.locator("#tv-guide .s22").count() === 1, "hotels (Stay22) should close the Guide");
  await page.locator("#tv-guide .g-pin.spot").first().click({ force: true }); await page.waitForTimeout(400);
  assert(await page.locator(".leaflet-popup-content b").count() === 1, "tapping a pin should open its card");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the Guide scrolls sideways on a phone");
  // Old #stay links land on the Guide; if the map can't load, the lists still say it all.
  await page.route("**/assets/leaflet-*.js", r => r.abort());
  await page.goto("about:blank");   // a fresh page, so the map library isn't already in memory
  await page.goto(BASE + "/knoxville/#stay", { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
  assert((await page.getAttribute('[data-tab="guide"]', "aria-selected")) === "true" && await page.isVisible("#tv-guide"), "#stay should open the Guide");
  const gm = await page.textContent("#tv-guide .g-map");
  assert(/didn't load/.test(gm) && await page.locator("#tv-guide .g-spot").count() === 3, `a failed map should leave a note and the lists (map says: ${gm.slice(0, 80)}; spots ${await page.locator("#tv-guide .g-spot").count()})`);
  } finally {
    page.off("request", countMap);
    for (const u of ["**/assets/leaflet-*.js", "https://tile.openstreetmap.org/**", "**/rest/v1/places?*", "**/rest/v1/posts?*"]) await page.unroute(u);
  }
});

await test("Reply links: /<city>/add/?kind=&text= opens with their words filled in", async () => {
  await go("/miami/add/?kind=hidden_gem&text=" + encodeURIComponent("I take everyone to the Venetian Pool on a weekday morning."));
  assert((await page.inputValue("#take")).startsWith("I take everyone to the Venetian Pool"), "reply text not pre-filled");
});

await test("New topic: city page box sends a take for review (with its topic)", async () => {
  await go("/miami/");
  assert(await page.locator("#nt").count() === 1, "new-topic box missing");
  assert(!(await page.isVisible("#nt-topic")), "new-topic form should be collapsed until opened");
  await page.click("#nt summary");
  await page.fill("#nt-topic", "TEST parking near South Beach");
  await page.click('[data-ntk="hidden_gem"]');
  await page.fill("#nt-text", "TEST use the city garages on 7th and 13th, cheaper than the meters.");
  const before = writes.length;
  await page.click("#nt-send");
  await page.waitForTimeout(1200);
  const w = writes.slice(before).find(x => x.table.startsWith("posts") && x.body.topic);
  assert(w && w.body.topic === "TEST parking near South Beach" && w.body.type === "hidden_gem", "take with topic was not sent");
  assert(/Thanks, it's in/.test(await page.textContent("#nt")), "thank-you state missing");
});

await test("Email signup: city page box checks the address, sends it with the city, then thanks", async () => {
  await go("/miami/");
  const box = page.locator("[data-signup]");
  assert(await box.count() === 1, "email signup box missing on city page");
  await page.fill("[data-signup] input[type=email]", "not-an-email");
  await page.click("[data-signup] button");
  assert(/doesn't look right/.test(await page.textContent("[data-signup] .signup-msg")), "bad email should be caught before sending");
  assert(!writes.some(x => x.table === "email_signup(rpc)"), "bad email was sent");
  await page.fill("[data-signup] input[type=email]", "test@example.com");
  await page.click("[data-signup] button");
  await page.waitForTimeout(1200);
  const w = writes.find(x => x.table === "email_signup(rpc)");
  assert(w && w.body.p_email === "test@example.com" && w.body.p_city && w.body.p_source === "city_page", "signup was not sent with city and source");
  assert(/on the list/.test(await page.textContent("[data-signup]")), "thank-you state missing");
  // Let in-flight fetches settle before the next test navigates. Bounded: the signup starts the lazy
  // anonymous session, whose refresh timer can keep the network from ever reading as idle.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
});

await test("Sign-in options: Facebook and TikTok buttons (preview), TikTok goes to the bridge", async () => {
  await go("/miami/?preview=signin");
  await page.evaluate(() => window.TV.openLogin());
  assert(await page.isVisible("#loginmodal .oauth.facebook"), "Facebook button missing");
  assert(await page.isVisible("#loginmodal [data-tiktok]"), "TikTok button missing");
  assert(await page.isVisible("#loginmodal [data-email-form] input[type=email]"), "email sign-in field missing");
  await page.fill("#loginmodal [data-email-form] input", "not-an-email");
  await page.click("#loginmodal [data-email-form] button");
  assert(/doesn't look right/.test(await page.textContent("#loginmodal [data-email-msg]")), "bad email should be caught before sending");
  assert((await page.locator("#loginmodal .oauth.google:visible").count()) + (await page.locator("#loginmodal [data-gsi]:visible").count()) <= 1, "two Google buttons showing");
  const req = page.waitForRequest(r => r.url().includes("/api/auth/tiktok/start?next=%2Fmiami%2F"), { timeout: 5000 });
  await page.click("#loginmodal [data-tiktok]");
  await req;
  await go("/miami/?signin=tiktok_off");
  assert(!page.url().includes("signin="), "sign-in message flag not cleared from the address");
});

await test("Feed voting: True/Nope toggles", async () => {
  const posts = await api("posts?select=id,city_id&type=in.(what_not_to_do,worst_times,hidden_gem)&limit=1");
  if (!posts.length) return;   // nothing to vote on yet
  const c = cities.find(x => x.id === posts[0].city_id);
  await go(`/${c.slug}/`);
  await page.click(".take .tvb.yes >> nth=0");
  await page.waitForTimeout(500);
  assert((await page.getAttribute(".take .tvb.yes >> nth=0", "aria-pressed")) === "true", "True did not toggle on");
  assert(writes.some(w => w.table === "votes"), "vote was not sent");
});

await test("Share a take: button on every card opens the share menu with the take's link", async () => {
  const posts = await api("posts?select=id,city_id&type=in.(what_not_to_do,worst_times,hidden_gem)&limit=1");
  if (!posts.length) return;
  const c = cities.find(x => x.id === posts[0].city_id);
  await go(`/${c.slug}/`);
  const n = await page.locator(".take").count();
  assert(await page.locator(".take .tv-share").count() === n, "a take card has no share button");
  const id = await page.getAttribute(".take .tv-share >> nth=0", "data-share-take");
  await page.evaluate(() => { window.__copied = ""; navigator.clipboard.writeText = async t => { window.__copied = t; }; });
  await page.click(".take .tv-share >> nth=0");
  assert(await page.isVisible("#sharesheet"), "share menu did not open");
  assert(new RegExp(`A ${c.name} local says`).test(await page.textContent("#sharesheet .sheet-q")), "share text missing city");
  for (const m of ["sms", "whatsapp", "facebook", "x", "email"]) {
    const h = await page.getAttribute(`#sharesheet [data-m="${m}"]`, "href");
    assert(h && decodeURIComponent(h).includes(`https://www.tripvibz.com/t/${id}`), `${m} link missing the take URL`);
  }
  await page.click('#sharesheet [data-m="copy"]');
  assert((await page.evaluate(() => window.__copied)).includes(`/t/${id}`), "copy link did not copy the take URL");
  assert(await page.locator("#sharesheet").count() === 0, "share menu did not close");
});

await test("Top 3 restaurants (where they'd take a friend to eat): section on city pages; anonymous sees sign-in; a signed-in person's picks are saved as one ranked list", async () => {
  await go("/miami/");
  assert(await page.locator("#tv-eats h2").count() === 1 && /take a friend to eat/i.test(await page.textContent("#tv-eats h2")), "top-3 section missing on the city page");
  assert(await page.locator("#top3-signin").count() === 1, "anonymous visitor should be offered sign-in, not the picker");
  assert(await page.locator('#tv-eats a[href="/how-we-verify-locals/"]').count() === 1, "section should link to how badges work");

  // A signed-in (non-anonymous) person: a second browser with a stored Google-style session.
  const me = randomUUID(), exp2 = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: me, role: "authenticated", is_anonymous: false, exp: exp2, aud: "authenticated" })}.sig`;
  const user = { id: me, aud: "authenticated", role: "authenticated", is_anonymous: false, app_metadata: { provider: "google" }, user_metadata: { full_name: "Test Local" }, created_at: new Date().toISOString() };
  const session = { access_token: jwt, token_type: "bearer", expires_in: 3600, expires_at: exp2, refresh_token: "test2", user };
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx2.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ["sb-nkxorlktzbgwqnfwmuus-auth-token", JSON.stringify(session)]);
  await ctx2.route(`${SB}/auth/v1/**`, r => r.fulfill({ json: r.request().url().includes("/user") ? user : session }));
  const before = writes.length;
  const PLACE = { id: "overture-test-place-1", name: "The Salty Donut", category: "donut_shop", address: "50 NW 23rd St", locality: "Miami", phone: "+17864094714", website: "https://www.saltydonut.com/", lat: 25.7994, lng: -80.1984, status: "open" };
  const ENSURED = randomUUID();
  await ctx2.route(`${SB}/rest/v1/**`, async r => {
    const req = r.request(), m = req.method(), url = req.url();
    const headers = { ...req.headers() }; delete headers.authorization;
    // The places catalogue search and the server-side "restaurant from catalogue" call, faked.
    if (url.includes("/rpc/search_places")) { let b = {}; try { b = JSON.parse(req.postData() || "{}"); } catch {} ; return r.fulfill({ json: /salty/i.test(b.p_q || "") ? [PLACE, { ...PLACE, id: "overture-test-place-2", name: "Salty Flats Cafe", address: "1 Ocean Dr", locality: "Miami Beach" }] : [] }); }
    if (url.includes("/rpc/popular_places")) return r.fulfill({ json: [{ ...PLACE, id: "overture-test-place-3", name: "Joe's Stone Crab", address: "11 Washington Ave", locality: "Miami Beach", review_count: 12840, picks: 0 }, { ...PLACE, review_count: null, picks: 2 }] });
    if (url.includes("/rpc/ensure_restaurant_from_place")) { let b = {}; try { b = JSON.parse(req.postData() || "{}"); } catch {} ; writes.push({ table: "ensure_restaurant_from_place(rpc)", method: m, body: b, who: me }); return r.fulfill({ json: ENSURED }); }
    if (m === "GET" || m === "HEAD" || url.includes("/rpc/")) return r.continue({ headers });
    let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
    const table = new URL(url).pathname.split("/").pop();
    writes.push({ table, method: m, body, who: me });
    const rows = (Array.isArray(body) ? body : [body]).map(x => ({ id: randomUUID(), created_at: new Date().toISOString(), ...x }));
    const single = (headers.accept || "").includes("vnd.pgrst.object");
    return r.fulfill({ status: m === "POST" ? 201 : 200, json: single ? rows[0] : rows });
  });
  await ctx2.route("**/api/locate", r => r.fulfill({ json: { ok: true, near: [] } }));
  const p2 = await ctx2.newPage();
  const errs2 = []; p2.on("pageerror", e => errs2.push(e.message));
  await p2.goto(BASE + "/miami/", { waitUntil: "networkidle" }); await p2.waitForTimeout(800);
  assert(await p2.locator("#top3-open").count() === 1, "signed-in person should see the Add-your-top-3 button");
  await p2.click('[data-tab="eat"]');   // the picker lives in the Eat tab
  await p2.click("#top3-open");
  // Row 1 from the catalogue: type, see suggestions with addresses, pick one.
  await p2.type("#top3-n1", "salty", { delay: 20 }); await p2.waitForTimeout(600);
  assert(await p2.locator("#top3-s1 button[data-pick]").count() === 3, "typing should list the two catalogue matches plus 'use as typed'");
  assert(/50 NW 23rd St/.test(await p2.textContent("#top3-s1")), "suggestions should show the address");
  await p2.click('#top3-s1 button[data-pick="overture-test-place-1"]'); await p2.waitForTimeout(200);
  assert((await p2.inputValue("#top3-n1")) === "The Salty Donut", "picking a suggestion should fill the exact catalogue name");
  assert(/50 NW 23rd St/.test(await p2.textContent("#top3")), "picked place should show its address under the field");
  await p2.fill("#top3-w1", "Get the guava and cheese, go before 10.");
  // Row 2: focusing the empty field offers the city's best-known places, most reviewed first.
  await p2.focus("#top3-n2"); await p2.waitForTimeout(400);
  const pop = await p2.textContent("#top3-s2");
  assert(/Best known in Miami/.test(pop) && /Joe's Stone Crab/.test(pop) && /12,840 reviews/.test(pop) && /picked by 2 people/.test(pop), `before typing, the best-known list should show review counts and pick counts: ${pop.slice(0, 160)}`);
  assert(pop.indexOf("Joe's Stone Crab") < pop.indexOf("The Salty Donut"), "most reviewed should come first");
  // Rows 2 and 3 typed by hand (not in the catalogue).
  await p2.fill("#top3-n2", "La Camaronera");
  await p2.fill("#top3-n3", "la camaronera");   // same place twice, typed differently
  await p2.click("#top3-save"); await p2.waitForTimeout(300);
  assert(/same place twice/i.test(await p2.textContent("#top3")), "duplicate names should be caught before saving");
  assert((await p2.inputValue("#top3-n1")) === "The Salty Donut" && /50 NW 23rd St/.test(await p2.textContent("#top3")), "a validation message must not wipe the picked place");
  await p2.fill("#top3-n3", "Versailles");
  await p2.click("#top3-save"); await p2.waitForTimeout(1500);
  const mine = writes.slice(before).filter(w => w.who === me);
  const shown = await p2.locator("#top3 .err").count() ? await p2.textContent("#top3 .err") : "";
  const ensured = mine.filter(w => w.table === "ensure_restaurant_from_place(rpc)");
  assert(ensured.length === 1 && ensured[0].body.p_place === "overture-test-place-1", `the catalogue pick must go through ensure_restaurant_from_place (got ${ensured.length}); page says "${shown}"; errors: ${errs2.join(" | ")}`);
  const rests = mine.filter(w => w.table === "restaurants" && w.method === "POST");
  assert(rests.length === 2 && rests.every(w => w.body.city_id && w.body.created_by === me && w.body.name) && !rests.some(w => w.body.address || w.body.phone), `expected 2 hand-typed restaurant rows (name + created_by only), got ${rests.length}`);
  assert(mine.some(w => w.table === "top3_picks" && w.method === "DELETE"), "old list should be cleared before the new one is written");
  const picks = mine.find(w => w.table === "top3_picks" && w.method === "POST");
  assert(picks && Array.isArray(picks.body) && picks.body.length === 3, "three picks should be inserted together");
  assert(picks.body.map(x => x.rank).join() === "1,2,3" && picks.body.every(x => x.user_id === me && x.city_id && x.restaurant_id), "picks must carry rank 1-3, the user and the city");
  assert(picks.body[0].restaurant_id === ENSURED, "the catalogue pick must reference the row the database returned");
  assert(picks.body[0].why === "Get the guava and cheese, go before 10." && picks.body[1].why === null, "why text should be kept, blanks saved as null");
  assert(!errs2.length, `page errors: ${errs2[0]}`);
  await ctx2.close();
});

await test("Thread: split bar, replies, typed reply", async () => {
  const posts = await api("posts?select=id&limit=1");
  if (!posts.length) return;
  await go(`/t/${posts[0].id}`);
  assert(await page.locator(".rbar").count() === 1, "split bar missing");
  await page.click("#share-take");
  const fb = await page.getAttribute('#sharesheet [data-m="facebook"]', "href");
  assert(fb && decodeURIComponent(fb).includes(`/t/${posts[0].id}`), "thread share link wrong");
  await page.keyboard.press("Escape");
  assert(await page.locator("#sharesheet").count() === 0, "Escape did not close the share menu");
  await page.click('[data-kind="disagree"]');
  await page.fill("#reply", "TEST it is fine before 6pm");
  await page.click("#send");
  await page.waitForTimeout(800);
  assert(writes.some(w => w.table === "comments" && w.body.kind === "disagree"), "reply not sent");
});

await test("Installable (PWA): the service worker registers and saves the shell, a visited city page opens offline, unvisited pages get the offline page, and repeat visitors get the home-screen offer", async () => {
  // Chromium with an iPhone user agent: Safari-style "Share → Add to Home Screen" offer (Chrome's own prompt never fires headless).
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (Version/17.5 Mobile/15E148 Safari/604.1" });
  const errs3 = [];
  try {
    const p3 = await ctx3.newPage();
    p3.on("pageerror", e => errs3.push(e.message));
    await p3.goto(BASE + "/", { waitUntil: "networkidle" });
    const reg = await p3.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then(r => ({ scope: r.scope, active: !!r.active })),
      new Promise(res => setTimeout(() => res({ timeout: true }), 10000))
    ]));
    assert(reg.active && /\/$/.test(reg.scope), `service worker did not register: ${JSON.stringify(reg)}`);
    // Precache lands shortly after install.
    let keys = [];
    for (let i = 0; i < 20 && !keys.some(k => k.startsWith("tv-shell-")); i++) { await p3.waitForTimeout(250); keys = await p3.evaluate(() => caches.keys()); }
    assert(keys.some(k => k.startsWith("tv-shell-")), `shell cache missing: ${keys.join(", ")}`);
    const shell = await p3.evaluate(async () => { const c = await caches.open((await caches.keys()).find(k => k.startsWith("tv-shell-"))); return (await c.keys()).map(r => new URL(r.url).pathname); });
    for (const want of ["/", "/offline/", "/cities/", "/assets/tv.js", "/site.webmanifest"]) assert(shell.includes(want), `shell cache lacks ${want}: ${shell.join(", ")}`);
    assert(await p3.locator(".a2hs").count() === 0, "first visit must not show the home-screen offer");
    // Second visit: the offer appears, says how on iOS, and "Not now" keeps it away.
    await p3.goto(BASE + "/miami/", { waitUntil: "networkidle" });
    await p3.waitForSelector(".a2hs.in", { timeout: 8000 });
    assert(/Add to Home Screen/.test(await p3.textContent(".a2hs")), "iOS offer should explain Share → Add to Home Screen");
    assert(await p3.locator(".a2hs .a2hs-add").count() === 0, "iOS has no install prompt, so no Add button");
    await p3.click(".a2hs .a2hs-x"); await p3.waitForTimeout(400);
    assert(await p3.locator(".a2hs").count() === 0, "Not now should close the offer");
    assert((await p3.evaluate(() => JSON.parse(localStorage.getItem("tv.a2hs")).dismissed)) > 0, "dismissal should be remembered");
    await p3.reload({ waitUntil: "networkidle" }); await p3.waitForTimeout(4500);
    assert(await p3.locator(".a2hs").count() === 0, "dismissed offer came back on the next visit");
    // Offline: the city page just visited still opens; one never visited gets the offline page; back online, live again.
    await ctx3.setOffline(true);
    await p3.goto(BASE + "/miami/", { waitUntil: "domcontentloaded" }); await p3.waitForTimeout(500);
    assert(/Know Miami\?/.test(await p3.textContent("h1")), "visited city page should open from the cache when offline");
    await p3.goto(BASE + "/asheville/", { waitUntil: "domcontentloaded" }); await p3.waitForTimeout(500);
    assert(/You're offline/.test(await p3.textContent("h1")), "an unvisited page should show the offline page");
    await ctx3.setOffline(false);
    await p3.goto(BASE + "/asheville/", { waitUntil: "domcontentloaded" }); await p3.waitForTimeout(500);
    assert(/Know Asheville\?/.test(await p3.textContent("h1")), "back online, the live page should load");
    // Standalone (opened from the home screen): no offer, ever.
    const p4 = await ctx3.newPage();
    await p4.addInitScript(() => { Object.defineProperty(navigator, "standalone", { get: () => true }); });
    await p4.evaluate(() => {}).catch(() => {});
    await p4.goto(BASE + "/cities/", { waitUntil: "networkidle" }); await p4.waitForTimeout(4500);
    assert(await p4.locator(".a2hs").count() === 0, "installed app must not be asked to install");
    assert(errs3.length === 0, "JS errors in the PWA context: " + errs3.join(" | "));
  } finally { await ctx3.close(); }
});

await test("No JavaScript errors on any page", async () => {
  assert(errors.length === 0, errors.slice(0, 3).join(" | "));
});

await browser.close();
if (server) server.close();

const failed = results.filter(r => r[0] === "FAIL");
for (const r of results) console.log(r.join("  "));
console.log(`\n${results.length - failed.length}/${results.length} passed · ${writes.length} writes intercepted (none reached the database)`);
process.exit(failed.length ? 1 : 0);
