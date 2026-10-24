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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await intercept(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(`${page.url()}: ${e.message}`));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
const go = async path => { await page.goto(BASE + path, { waitUntil: "networkidle" }); await page.waitForTimeout(800); };

const cities = await api("cities?select=id,slug,name&order=sort");
const qs = await api("questions?select=city_id,sort,prompt&active=eq.true&order=sort");
const lead = slug => { const c = cities.find(x => x.slug === slug); return qs.find(q => q.city_id === c.id); };

await test("Home: hero, city grid, logo, request link", async () => {
  await go("/");
  assert(/The local take on every city/i.test(await page.textContent("h1")), "headline missing");
  const n = await page.locator("#needs a").count();
  assert(n >= cities.length, `city grid shows ${n} of ${cities.length}`);
  assert(await page.locator("header .brand-mark").count() === 1, "logo missing in header");
  assert(await page.locator('a[href="/cities/#request"]').count() === 1, "Ask for your city link missing");
  assert(await page.locator('link[rel="icon"]').count() >= 1, "favicon link missing");
});

await test("Cities page: grid, search, request-a-city", async () => {
  await go("/cities/");
  assert(await page.locator(".city-card").count() >= cities.length, "city cards missing");
  await page.fill("#search", "zzzz");
  assert(/No cities match/.test(await page.textContent("#live-grid")), "empty search state missing");
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

for (const slug of ["nashville", "knoxville", "miami"]) {
  await test(`City feed (${slug}): hero photo, lead question, sections, no old add button`, async () => {
    await go(`/${slug}/`);
    assert(/What locals say about/.test(await page.textContent("h1")), "headline missing");
    const w = await page.evaluate(() => { const i = document.querySelector(".city-hero"); return i ? i.naturalWidth : 0; });
    assert(w > 0, "hero photo did not load");
    assert((await page.textContent(".qcard .qp")).trim() === lead(slug).prompt, "lead question is not the first active question");
    assert(await page.locator(".qcard a.qopt").count() >= 2, "question options missing");
    const hasTakes = (await page.locator(".feed .take").count()) > 0;
    assert(await page.locator("[data-sec]").count() === (hasTakes ? 4 : 0), hasTakes ? "section chips missing" : "filter chips should be hidden when there are no takes");
    assert(await page.locator("details.nt:not([open])").count() === 1, "new-topic box should start collapsed");
    assert(await page.locator(".fab").count() === 0, "old \"What do tourists get wrong\" button is back");
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

await test("Post a take anonymously: kinds, starter, place, months, preview, posted page", async () => {
  await go("/nashville/add/");
  await page.click('[data-kind="worst_times"]');
  await page.click("[data-starter] >> nth=0");
  await page.fill("#take", "TEST avoid Broadway on CMA Fest weekend, sidewalks do not move");
  if (await page.locator('[data-place="__custom"]').count()) { await page.click('[data-place="__custom"]'); await page.fill("#custom", "Lower Broadway"); }
  await page.click('[data-month="6"]');
  if (await page.locator('[data-tenure="10+"]').count()) await page.click('[data-tenure="10+"]');
  assert(/Lower Broadway/.test(await page.textContent(".sect .take")), "preview missing place");
  await page.click("#post-anon");
  await page.waitForTimeout(1500);
  assert(writes.some(w => w.table.startsWith("posts")), "take was not sent");
  assert(/Your take is live/.test(await page.textContent("#root")), "posted page missing");
  assert(await page.evaluate(() => { const c = document.querySelector("#card"); return c && c.width === 1080; }), "share card not drawn");
});

await test("Sign in with Google: badge button opens the sign-in box", async () => {
  await go("/nashville/add/");
  await page.fill("#take", "TEST the badge flow opens sign in");
  await page.click("#post-badge");
  await page.waitForTimeout(800);
  assert(await page.isVisible("#loginmodal"), "sign-in box did not open");
});

await test("Topic page: new take cards, starters open the add page, calendar on worst times", async () => {
  await go("/nashville/what-not-to-do/");
  assert(/What not to do in Nashville/.test(await page.textContent("h1")), "headline missing");
  assert(await page.locator(".takes .chips a.chip").count() === 4, "section chips (same as the city page) missing");
  assert(await page.locator(".takes .chips a.chip[aria-pressed=\"true\"]").count() === 1, "current section should be selected");
  const s = await page.getAttribute(".qcard a.qopt >> nth=0", "href");
  assert(s && s.startsWith("/nashville/add/?kind=what_not_to_do"), "starter link wrong");
  assert(!(await page.content()).includes("Cosign"), "old Cosign UI is back");
  await go("/nashville/worst-times-to-visit/");
  assert(await page.locator(".cal-months .m").count() === 12, "month calendar missing");
  assert(/Researched by the TripVibz editors/.test(await page.textContent(".cal")), "calendar must be labeled as editors' research, not locals");
  const sel = page.locator('.cal-months .m[aria-pressed="true"] .mn');
  assert(await sel.count() === 1 && await sel.evaluate(e => getComputedStyle(e).color !== getComputedStyle(e.closest("button")).backgroundColor), "selected month label invisible");
});

await test("City page: When-to-go strip links to the month-by-month calendar", async () => {
  await go("/nashville/");
  await page.waitForSelector("a.when", { timeout: 8000 });
  assert(await page.locator(".when-strip span").count() === 12, "month strip should have 12 cells");
  assert((await page.getAttribute("a.when", "href")) === "/nashville/worst-times-to-visit/", "strip should link to the calendar");
  const best = await page.textContent(".when-t .wl:first-child");
  assert(/Best/i.test(best) && /·\s*\S/.test(best), "Best line should name the reason (e.g. 'Mar–May · Spring')");
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
  await page.click("#nt-send");
  await page.waitForTimeout(1200);
  const w = writes.find(x => x.table.startsWith("posts") && x.body.topic);
  assert(w && w.body.topic === "TEST parking near South Beach" && w.body.type === "hidden_gem", "take with topic was not sent");
  assert(/Thanks, it's in/.test(await page.textContent("#nt")), "thank-you state missing");
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

await test("No JavaScript errors on any page", async () => {
  assert(errors.length === 0, errors.slice(0, 3).join(" | "));
});

await browser.close();
if (server) server.close();

const failed = results.filter(r => r[0] === "FAIL");
for (const r of results) console.log(r.join("  "));
console.log(`\n${results.length - failed.length}/${results.length} passed · ${writes.length} writes intercepted (none reached the database)`);
process.exit(failed.length ? 1 : 0);
