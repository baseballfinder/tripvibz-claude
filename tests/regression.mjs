// Regression guards: two site-wide rules that a new or changed feature must not
// break, checked on every pull request and merge (.github/workflows/tests.yml).
//
//   node build.mjs && node tests/regression.mjs          (serves dist/ on :8092)
//   ONLY=build node tests/regression.mjs                 (part 1 only)
//   ONLY=return node tests/regression.mjs                (part 2 only)
//
// PART 1 — "The page's script keeps what the build wrote."
//   build.mjs writes each page's search title, description, headline and
//   pre-rendered blocks. Google runs the page's script too, so a script that
//   replaces any of them throws that work away without any other test noticing
//   (Nov 2026: article.html swapped the search title for a generic one on load).
//   Every page in dist/ is loaded twice, script off and script on, and compared.
//   New pages and page types are picked up automatically.
//
// PART 2 — "What you did is still there when you come back."
//   A visitor does each thing the site lets them do, leaves, and comes back as
//   the same person. The page must show it as done and not ask again
//   (Nov 2026: the add page asked people questions they had already answered).
//   Writes never reach the live database: they go to an in-memory copy that
//   answers later reads the way the database would. The list at the bottom
//   (COMES_BACK / NOTHING_TO_SHOW) must name every write the pages make, so a
//   new write path fails here until it has a "comes back" check or a reason.
import { chromium } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serveDist } from "./_serve.mjs";

const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const ONLY = process.env.ONLY || "";
const server = await serveDist(8092);
const BASE = "http://localhost:8092";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n").slice(0, 12).join("\n      ")]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const api = async path => (await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } })).json();

const browser = await chromium.launch();
const VIEW = { width: 390, height: 844 };

/* =====================================================================
   PART 1 — the page's script keeps what the build wrote
   ===================================================================== */

// What a search engine or a share preview reads, plus the blocks the build marks as its own (id="tv-…").
const snapshot = () => {
  const at = (sel, a) => { const e = document.querySelector(sel); return e ? e.getAttribute(a) : null; };
  const text = e => e.textContent.replace(/\s+/g, " ").trim();
  return {
    title: document.title,
    description: at('meta[name="description"]', "content"),
    robots: at('meta[name="robots"]', "content"),
    canonical: at('link[rel="canonical"]', "href"),
    "og:title": at('meta[property="og:title"]', "content"),
    "og:description": at('meta[property="og:description"]', "content"),
    "og:image": at('meta[property="og:image"]', "content"),
    "og:url": at('meta[property="og:url"]', "content"),
    lang: document.documentElement.getAttribute("lang"),
    h1: [...document.querySelectorAll("h1")].map(text),
    h2: [...document.querySelectorAll("h2")].map(text),
    structuredData: [...document.querySelectorAll('script[type="application/ld+json"]')].map(e => e.textContent.replace(/\s+/g, " ").trim()),
    buildBlocks: [...document.querySelectorAll('[id^="tv-"]')].map(e => e.id)
  };
};

// Fields that must be identical before and after the script runs, on every page.
const ALWAYS = ["robots", "canonical", "og:title", "og:description", "og:image", "og:url", "lang"];
// Also identical on pages search engines may index. (A noindex page, such as the add and
// vote pages, is drawn by its script and may set its own title and headline.)
const WHEN_INDEXED = ["title", "description"];

// A deliberate exception goes here with its reason, never by loosening the rules above.
//   { route: /^\/some-page\/$/, field: "title", why: "…" }
const ALLOWED_CHANGES = [];
const allowed = (route, field) => ALLOWED_CHANGES.some(a => a.route.test(route) && a.field === field);

async function routesInDist(dir = "dist", base = "/") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (base === "/" && e.name === "assets") continue; out.push(...await routesInDist(join(dir, e.name), base + e.name + "/")); }
    else if (e.name === "index.html") out.push(base);
  }
  return out.sort();
}

function compare(route, built, loaded, indexed) {
  const bad = [];
  const say = (field, b, l) => { if (!allowed(route, field)) bad.push(`${route}  ${field}\n        built : ${JSON.stringify(b)}\n        loaded: ${JSON.stringify(l)}`); };
  for (const f of ALWAYS.concat(indexed ? WHEN_INDEXED : [])) if (built[f] !== loaded[f]) say(f, built[f], loaded[f]);
  if (indexed) {
    if (built.h1.join(" | ") !== loaded.h1.join(" | ")) say("h1", built.h1, loaded.h1);
    // The script may add sections (takes, signup box); it may not drop or reorder the build's headings.
    let i = 0; for (const h of loaded.h2) if (i < built.h2.length && h === built.h2[i]) i++;
    if (i < built.h2.length) say("h2 (a pre-rendered section heading was removed or renamed)", built.h2, loaded.h2);
    if (built.structuredData.join("\n") !== loaded.structuredData.join("\n")) say("structured data (JSON-LD)", built.structuredData.length + " block(s)", loaded.structuredData.length + " block(s), changed");
  }
  for (const id of built.buildBlocks) {
    const n = loaded.buildBlocks.filter(x => x === id).length;
    if (n !== 1) say(`pre-rendered block #${id}`, "present once", n ? `present ${n} times` : "removed by the script");
  }
  return bad;
}

if (ONLY !== "return") await test("The page's script keeps what the build wrote: search title, description, canonical, share tags, headline, structured data and pre-rendered blocks are the same before and after load, on every page in dist/", async () => {
  const routes = await routesInDist();
  assert(routes.length > 50, `expected the whole site in dist/, found ${routes.length} pages. Run node build.mjs first`);
  const rawCtx = await browser.newContext({ javaScriptEnabled: false, viewport: VIEW });
  const liveCtx = await browser.newContext({ viewport: VIEW, serviceWorkers: "block" });
  await liveCtx.route(`${SB}/auth/v1/**`, r => r.fulfill({ status: 400, json: { error: "no session in this test" } }));
  await liveCtx.route(`${SB}/rest/v1/**`, r => /^(GET|HEAD)$/.test(r.request().method()) || r.request().url().includes("/rpc/") ? r.continue() : r.fulfill({ status: 204, body: "" }));
  const bad = []; let checked = 0, indexedCount = 0;
  const queue = routes.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    const raw = await rawCtx.newPage(), live = await liveCtx.newPage();
    for (let route; (route = queue.shift()); ) {
      await raw.goto(BASE + route, { waitUntil: "domcontentloaded" });
      const built = await raw.evaluate(snapshot);
      await live.goto(BASE + route, { waitUntil: "networkidle" }); await live.waitForTimeout(700);
      const loaded = await live.evaluate(snapshot);
      const indexed = !/noindex/i.test(built.robots || "");
      if (indexed) { indexedCount++; if (!built.title || built.title === "TripVibz") bad.push(`${route}  an indexed page was built without its own title`); }
      bad.push(...compare(route, built, loaded, indexed)); checked++;
    }
    await raw.close(); await live.close();
  }));
  await rawCtx.close(); await liveCtx.close();
  assert(checked === routes.length && indexedCount >= 30, `only ${checked} of ${routes.length} pages were compared (${indexedCount} indexed)`);
  assert(!bad.length, `${bad.length} thing(s) the build wrote were changed by a page script. Google and share previews should see what build.mjs wrote; make the script keep it (or list a deliberate exception in ALLOWED_CHANGES with its reason):\n      ${bad.slice(0, 8).join("\n      ")}${bad.length > 8 ? `\n      …and ${bad.length - 8} more` : ""}`);
});

/* =====================================================================
   PART 2 — what you did is still there when you come back
   ===================================================================== */

// ---- an in-memory copy of the tables people write to ----
// Writes land here and never reach the live database. Reads of these tables get the live rows
// plus the matching rows from here, so a page reloaded later sees what "the database" now holds.
const MEMORY_TABLES = ["question_votes", "votes", "vibe_tags", "top3_picks", "restaurants", "city_tenure", "city_requests", "comments", "posts"];
const store = Object.fromEntries(MEMORY_TABLES.map(t => [t, []]));
const OWNER_COLUMN = { question_votes: "user_id", votes: "user_id", vibe_tags: "user_id", top3_picks: "user_id", city_tenure: "user_id", city_requests: "user_id", comments: "author_id", posts: "author_id", restaurants: "created_by" };
const READ_ONLY_RPCS = ["question_results", "search_places", "popular_places", "search_take_places"];
const writes = [];   // { target, method, body, who }

const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function rowFilter(url) {
  const conds = [...new URL(url).searchParams].filter(([k]) => !NOT_FILTERS.has(k));
  return row => conds.every(([k, v]) => {
    if (v.startsWith("eq.")) return String(row[k]) === v.slice(3);
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").map(s => s.replace(/^"|"$/g, "")).includes(String(row[k]));
    if (v === "is.null") return row[k] == null;
    if (v === "not.is.null") return row[k] != null;
    return false;   // a filter this copy doesn't understand never matches, so nothing leaks into the wrong read
  });
}
const POST_DEFAULTS = { status: "approved", ups: 0, downs: 0, comment_count: 0, author_verified: false, body: null, months: null, place_id: null, place_label: null, topic: null, question_id: null };

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
async function person({ signedIn = false } = {}) {
  const id = randomUUID(), exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: id, role: "authenticated", is_anonymous: !signedIn, exp, aud: "authenticated" })}.sig`;
  const user = { id, aud: "authenticated", role: "authenticated", is_anonymous: !signedIn, app_metadata: signedIn ? { provider: "google" } : {}, user_metadata: signedIn ? { full_name: "Test Returning" } : {}, created_at: new Date().toISOString() };
  const session = { access_token: jwt, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "test-" + id, user };
  const ctx = await browser.newContext({ viewport: VIEW, serviceWorkers: "block" });
  ctx.setDefaultTimeout(8000);   // a missing button should fail the check in seconds, with its own message
  // A signed-in person arrives with their session; an anonymous one gets theirs on the first thing they do.
  if (signedIn) await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch {} }, ["sb-nkxorlktzbgwqnfwmuus-auth-token", JSON.stringify(session)]);
  await ctx.route(`${SB}/auth/v1/**`, r => r.fulfill({ json: r.request().url().includes("/user") ? user : session }));
  await ctx.route(`${SB}/rest/v1/**`, async r => {
    const req = r.request(), m = req.method(), url = req.url();
    const headers = { ...req.headers() }; delete headers.authorization;   // live reads go out as the public key
    const single = (headers.accept || "").includes("vnd.pgrst.object");
    const name = new URL(url).pathname.split("/").pop();
    let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
    if (url.includes("/rpc/")) {
      if (name === "question_results") {   // live tallies plus the votes held here
        let data = []; try { data = await (await r.fetch({ headers })).json(); } catch {}
        if (!Array.isArray(data)) data = [];
        for (const v of store.question_votes.filter(v => (body.qids || []).includes(v.question_id))) {
          const row = data.find(x => x.question_id === v.question_id && x.option_id === v.option_id);
          if (row) row.n = Number(row.n) + 1; else data.push({ question_id: v.question_id, option_id: v.option_id, n: 1 });
        }
        return r.fulfill({ json: data });
      }
      if (READ_ONLY_RPCS.includes(name)) return r.continue({ headers });
      writes.push({ target: "rpc:" + name, method: m, body, who: id });
      return r.fulfill({ json: /^ensure_/.test(name) ? randomUUID() : null });
    }
    const mem = store[name];
    if (m === "GET") {
      if (!mem) return r.continue({ headers });
      let live = null, data = [];
      try { live = await r.fetch({ headers }); data = await live.json(); } catch {}
      const mine = mem.filter(rowFilter(url));
      if (single) return mine.length ? r.fulfill({ json: mine[0] }) : live ? r.fulfill({ response: live }) : r.fulfill({ status: 406, json: {} });
      return r.fulfill({ json: (Array.isArray(data) ? data : []).concat(mine) });
    }
    if (m === "HEAD") return r.continue({ headers });
    writes.push({ target: name, method: m, body, who: id });
    if (!mem) return r.fulfill({ status: 200, json: [] });   // a write to a table not copied here: recorded, kept off the live site
    let rows = [];
    if (m === "POST") {
      const conflict = (new URL(url).searchParams.get("on_conflict") || "").split(",").filter(Boolean);
      rows = (Array.isArray(body) ? body : [body]).map(x => {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...(name === "posts" ? POST_DEFAULTS : {}), [OWNER_COLUMN[name]]: id, ...x };
        const i = conflict.length ? mem.findIndex(o => conflict.every(c => String(o[c]) === String(row[c]))) : -1;
        if (i >= 0) { mem[i] = { ...mem[i], ...x }; return mem[i]; }
        mem.push(row); return row;
      });
    } else if (m === "DELETE") {
      const hit = rowFilter(url); rows = mem.filter(hit);
      store[name] = mem.filter(x => !hit(x));
    } else if (m === "PATCH") {
      rows = mem.filter(rowFilter(url)); rows.forEach(x => Object.assign(x, body));
    }
    return r.fulfill({ status: m === "POST" ? 201 : 200, json: single ? rows[0] || null : rows });
  });
  await ctx.route("**/api/**", async r => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/take") {
      let body = {}; try { body = JSON.parse(r.request().postData() || "{}"); } catch {}
      writes.push({ target: "/api/take", method: "POST", body, who: id });
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...POST_DEFAULTS, author_id: id, ...body };
      store.posts.push(row);
      return r.fulfill({ json: { row } });
    }
    if (p === "/api/locate") return r.fulfill({ json: { ok: true, near: [] } });
    if (p === "/api/near") return r.fulfill({ json: { ok: false } });
    return r.fulfill({ status: 204, body: "" });
  });
  const errors = [];
  const me = { id, ctx, errors, page: null };
  // open(): first visit, or coming back. Coming back closes the old tab first, so nothing a page
  // kept in its own variables or in sessionStorage survives; only the person's session does.
  me.open = async path => {
    if (me.page) await me.page.close();
    const p = me.page = await ctx.newPage();
    p.on("pageerror", e => errors.push(`${path}: ${e.message}`));
    await p.goto(BASE + path, { waitUntil: "networkidle" }); await p.waitForTimeout(800);
    return p;
  };
  me.wrote = (target, since = 0) => writes.slice(since).filter(w => w.who === id && w.target === target);
  return me;
}

const covered = new Set();   // write targets a scenario below actually sent and then saw come back
async function comesBack(targets, name, fn) {
  await test(`Comes back: ${name}`, async () => {
    const before = writes.length;
    await fn();
    const sent = new Set(writes.slice(before).map(w => w.target));
    for (const group of targets) {   // a group is one target, or alternatives ("posts" directly or through /api/take)
      const alts = [].concat(group);
      assert(alts.some(t => sent.has(t)), `this check is listed as covering ${alts.join(" or ")}, but nothing was written there. The page changed how it saves; update this check`);
      alts.forEach(t => covered.add(t));
    }
  });
}

if (ONLY !== "build") {
  const REMOVED = await readFile("data/removed-cities.json", "utf8").then(JSON.parse).catch(() => ({}));
  const cities = (await api("cities?select=id,slug,name&order=sort")).filter(c => !REMOVED[c.slug]);
  const city = slug => cities.find(c => c.slug === slug);
  const nash = city("nashville");
  const nashQs = await api(`questions?select=id,prompt&city_id=eq.${nash.id}&active=eq.true&order=sort`);
  const livePosts = await api("posts?select=id,city_id,type&status=eq.approved&order=ups.desc&limit=40");
  assert(nashQs.length >= 2, "Nashville needs at least two active questions for these checks");

  const anon = await person();
  const [q1, q2] = nashQs;
  const card = (p, q) => p.locator(`#qlist [data-q="${q.id}"]`);
  const WHY = "REGRESSION TEST go on a weekday before noon, it is a different place";

  await comesBack(["question_votes"], "an answered question shows your answer on the add page and counts toward your progress, and the city page moves on to the next one", async () => {
    let p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator(".qopt.mine").count() === 0, "a first-time visitor should not have an answer yet");
    await card(p, q1).locator(".qopt").first().click(); await p.waitForTimeout(500);
    assert(anon.wrote("question_votes").length === 1, "the answer was not sent");
    p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator('.qopt.mine[aria-pressed="true"]').count() === 1, "back on the add page, the question you answered is shown as unanswered");
    assert(/^1 of /.test((await p.textContent(".progress")).trim()), `progress should count the answer you gave: "${await p.textContent(".progress")}"`);
    assert(await card(p, q1).locator(".why-box").count() === 0, "coming back should not reopen the why box as if you had just answered");
    p = await anon.open("/nashville/");
    // The city page's card moves on to the next unanswered question.
    assert(await p.locator(`.qcard a.qopt[href*="q=${q1.id}"]`).count() === 0, "the city page asks a question you already answered");
    assert((await p.textContent(".qcard .qp")).trim() === q2.prompt, `the city page should move on to the next question: "${await p.textContent(".qcard .qp")}"`);
  });

  await comesBack([["posts", "/api/take"]], "a take you wrote on a question is shown as yours, the question doesn't ask for it again, and it isn't offered back to you as someone else's", async () => {
    let p = await anon.open("/nashville/add/");
    await card(p, q1).locator(".qopt.mine").click(); await p.waitForTimeout(400);   // tapping your answer again opens the why box
    await card(p, q1).locator("[data-why]").fill(WHY);
    await card(p, q1).locator("[data-post-why]").click(); await p.waitForTimeout(1200);
    assert(/REGRESSION TEST/.test(await card(p, q1).locator(".mine-take").textContent()), "the take did not post");
    p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator(".mine-take").count() === 1 && /REGRESSION TEST/.test(await card(p, q1).locator(".mine-take").textContent()), "back on the add page, your take on the question is gone");
    await card(p, q1).locator(".qopt.mine").click(); await p.waitForTimeout(400);
    assert(await card(p, q1).locator(".why-box").count() === 0, "the question asks for a take you already wrote");
    assert(await card(p, q1).locator("[data-same]").count() === 0, "your own take is offered back to you as 'Same as mine'");
  });

  await comesBack(["votes"], "agreeing with a take already there ('Same as mine') still shows as agreed, without asking again", async () => {
    const other = { id: randomUUID(), created_at: new Date().toISOString(), ...POST_DEFAULTS, author_id: randomUUID(), city_id: nash.id, question_id: q2.id, type: "take", title: "REGRESSION TEST someone else already said this" };
    store.posts.push(other);
    let p = await anon.open("/nashville/add/");
    await card(p, q2).locator(".qopt").first().click(); await p.waitForTimeout(500);
    await card(p, q2).locator(`[data-same="${other.id}"]`).click(); await p.waitForTimeout(600);
    const v = anon.wrote("votes").pop();
    assert(v && v.body.post_id === other.id && v.body.value === 1, "'Same as mine' did not send a True vote");
    p = await anon.open("/nashville/add/");
    assert(await card(p, q2).locator(".mine-take.agreed").count() === 1, "back on the add page, the take you agreed with is no longer shown as agreed");
    assert(await card(p, q2).locator(".why-box").count() === 0, "the question asks again after you agreed with a take");
    store.posts = store.posts.filter(x => x.id !== other.id);
  });

  await comesBack(["city_tenure"], "how long you've lived in a city is asked once", async () => {
    let p = await anon.open("/nashville/add/");
    assert(await p.locator(".tenure-card").count() === 1, "someone who answered a question should be asked how long they've lived there");
    await p.locator(".tenure-card [data-tenure]").first().click(); await p.waitForTimeout(700);
    p = await anon.open("/nashville/add/");
    assert(await p.locator(".tenure-card").count() === 0, "the add page asks how long you've lived there a second time");
  });

  await comesBack(["votes"], "True on a take stays pressed on the city page and on every topic page that shows the take", async () => {
    const withTakes = cities.find(c => livePosts.some(x => x.city_id === c.id));
    assert(withTakes, "no city has an approved take to vote on");
    let p = await anon.open(`/${withTakes.slug}/`);
    const btn = p.locator('.take [data-vote="1"]').first();
    const id = await btn.getAttribute("data-id");
    await btn.click(); await p.waitForTimeout(600);
    assert(anon.wrote("votes").some(w => w.body.post_id === id && w.body.value === 1), "the True vote was not sent");
    p = await anon.open(`/${withTakes.slug}/`);
    assert(await p.locator(`.take [data-vote="1"][data-id="${id}"][aria-pressed="true"]`).count() >= 1, "back on the city page, your True vote is not shown");
    let seen = 0;
    for (const topic of ["what-not-to-do", "worst-times-to-visit", "what-locals-do"]) {
      p = await anon.open(`/${withTakes.slug}/${topic}/`);
      const here = p.locator(`.take [data-vote="1"][data-id="${id}"]`);
      if (!(await here.count())) continue;
      seen++;
      assert((await here.first().getAttribute("aria-pressed")) === "true", `the ${topic} page shows the same take without your True vote`);
    }
    assert(seen >= 1, "the take was not found on any topic page, so the vote was only checked on one page");
  });

  await comesBack(["vibe_tags"], "a vibe you gave a take still shows as yours", async () => {
    let found = null;
    for (const c of cities.filter(c => livePosts.some(x => x.city_id === c.id))) {
      const p = await anon.open(`/${c.slug}/`);
      if (await p.locator(".take [data-vibe-more]").count()) { found = c; break; }
    }
    assert(found, "no city page has a take that accepts a vibe");
    let p = anon.page;
    const more = p.locator(".take [data-vibe-more]").first();
    const id = await more.getAttribute("data-vibe-more");
    await more.click();
    await p.locator(`[data-vibes-for="${id}"] [data-vibe="first-timer"]`).click(); await p.waitForTimeout(600);
    assert(anon.wrote("vibe_tags").some(w => w.body.post_id === id), "the vibe was not sent");
    p = await anon.open(`/${found.slug}/`);
    assert(await p.locator(`[data-vibes-for="${id}"] [data-vibe="first-timer"][aria-pressed="true"]`).count() >= 1, "back on the city page, the vibe you gave is not shown as yours");
  });

  await comesBack(["comments"], "a reply you posted on a take is still on its page", async () => {
    const id = livePosts[0].id;
    let p = await anon.open(`/t/${id}`);
    await p.fill("#reply", "REGRESSION TEST still true on weekends");
    await p.click("#send"); await p.waitForTimeout(800);
    assert(anon.wrote("comments").length === 1, "the reply was not sent");
    p = await anon.open(`/t/${id}`);
    assert(/REGRESSION TEST still true on weekends/.test(await p.textContent("#root")), "back on the take's page, your reply is gone");
  });

  await comesBack(["city_requests"], "a city you asked for stays marked as asked", async () => {
    let p = await anon.open("/cities/");
    await p.evaluate(() => { try { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); navigator.clipboard.writeText = async () => {}; } catch (e) {} });
    const ask = p.locator("#req-list [data-ask]:not([disabled])").first();
    const slug = await ask.getAttribute("data-ask");
    const name = (await ask.locator("xpath=..").locator("b").textContent()).split(",")[0];
    await ask.click(); await p.waitForTimeout(700);
    assert(anon.wrote("city_requests").some(w => w.body.city_slug === slug), "the ask was not sent");
    p = await anon.open("/cities/");
    await p.fill("#req-q", name); await p.waitForTimeout(300);
    const again = p.locator(`#req-list [data-ask="${slug}"]`);
    assert(await again.count() === 1 && await again.isDisabled() && /Asked/.test(await again.textContent()), "back on the cities page, the city you asked for can be asked for again");
  });

  const local = await person({ signedIn: true });
  await comesBack(["top3_picks", "restaurants"], "a signed-in person's top 3 restaurants are still theirs, ready to edit", async () => {
    let p = await local.open("/miami/");
    await p.click('[data-tab="eat"]');
    assert(/Add your top 3/.test(await p.textContent("#top3-open")), "a person with no picks should be offered 'Add your top 3'");
    await p.click("#top3-open");
    const names = ["REGRESSION TEST Uno", "REGRESSION TEST Dos", "REGRESSION TEST Tres"];
    for (let i = 0; i < 3; i++) await p.fill(`#top3-n${i + 1}`, names[i]);
    await p.click("#top3-save"); await p.waitForTimeout(1500);
    const sent = local.wrote("top3_picks").find(w => w.method === "POST");
    assert(sent && sent.body.length === 3, `the three picks were not saved: ${(await p.locator("#top3 .err").count()) ? await p.textContent("#top3 .err") : "no error shown"}`);
    p = await local.open("/miami/");
    await p.click('[data-tab="eat"]');
    assert(/Edit your top 3/.test(await p.textContent("#top3-open")), "back on the city page, a person who picked a top 3 is asked to add one");
    await p.click("#top3-open");
    for (let i = 0; i < 3; i++) assert((await p.inputValue(`#top3-n${i + 1}`)) === names[i], `pick ${i + 1} did not come back as saved`);
  });

  await test("Coming back never throws a JavaScript error", async () => {
    const all = anon.errors.concat(local.errors);
    assert(!all.length, all.slice(0, 5).join(" | "));
  });

  // ---- the list: every write the pages make either comes back (checked above) or has a reason not to ----
  const COMES_BACK = ["question_votes", "posts", "/api/take", "votes", "vibe_tags", "city_tenure", "comments", "city_requests", "top3_picks", "restaurants"];
  const NOTHING_TO_SHOW = {
    "profiles": "copies the Google name and photo onto the profile at sign-in; nothing the person entered",
    "rpc:question_results": "a read (tallies)",
    "rpc:search_places": "a read (restaurant search)",
    "rpc:popular_places": "a read (best-known restaurants)",
    "rpc:search_take_places": "a read (spot search)",
    "rpc:ensure_restaurant_from_place": "server-side copy of a catalogue restaurant; the pick that uses it is checked (top3_picks)",
    "rpc:ensure_spot_from_place": "server-side copy of a catalogue spot; the take that uses it is checked (posts)",
    "rpc:create_claim": "sign-in handoff token, not something the person did on a page",
    "rpc:redeem_claim": "sign-in handoff: moves anonymous answers to the account (tests/e2e.mjs covers sign-in)",
    "rpc:email_signup": "email list signup has no account; there is nothing to show on return",
    "/api/hit": "page-view counter",
    "/api/error": "error beacon",
    "/api/locate": "location check for the Local badge; the badge is earned over weeks, not shown on return",
    "/api/near": "a read (cities near you)",
    "/api/event": "calendar suggestion; goes to review and is not shown until approved"
  };

  await test("Every write the pages make has a 'comes back' check, or a stated reason it has nothing to show", async () => {
    const files = (await readdir("assets")).filter(f => f.endsWith(".js")).map(f => join("assets", f))
      .concat((await readdir(".")).filter(f => f.endsWith(".html") && f !== "admin.html"));
    const found = new Map();
    const note = (target, file) => found.set(target, (found.get(target) || new Set()).add(file));
    for (const f of files) {
      const src = await readFile(f, "utf8");
      for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)\s*\.\s*(?:insert|upsert|update|delete)\b/g)) note(m[1], f);
      for (const m of src.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)) note("rpc:" + m[1], f);
      for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/\w+)/g)) note(m[1], f);
    }
    assert(found.size >= 15, `the scan for write paths found only ${found.size}; the pattern no longer matches how pages save`);
    const unlisted = [...found].filter(([t]) => !COMES_BACK.includes(t) && !(t in NOTHING_TO_SHOW));
    assert(!unlisted.length, `new write path with no returning-visitor check: ${unlisted.map(([t, fs]) => `${t} (${[...fs].join(", ")})`).join("; ")}. Add a "Comes back" check in tests/regression.mjs that does it, leaves, returns and sees it done (then list it in COMES_BACK), or add it to NOTHING_TO_SHOW with the reason`);
    const stale = COMES_BACK.concat(Object.keys(NOTHING_TO_SHOW)).filter(t => !found.has(t));
    assert(!stale.length, `listed here but no page writes it any more: ${stale.join(", ")}. Remove it from the list`);
    if (!ONLY) {
      const unchecked = COMES_BACK.filter(t => !covered.has(t) && !(["posts", "/api/take"].includes(t) && (covered.has("posts") || covered.has("/api/take"))));
      assert(!unchecked.length, `listed as coming back, but no check above exercised it: ${unchecked.join(", ")}`);
    }
    const leaked = MEMORY_TABLES.filter(t => !COMES_BACK.includes(t));
    assert(!leaked.length, `copied in memory but not in COMES_BACK: ${leaked.join(", ")}`);
  });

  await anon.ctx.close(); await local.ctx.close();
}

await browser.close();
server.close();
for (const [s, n, e] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n}${e ? `\n      ${e}` : ""}`);
const failed = results.filter(r => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed · ${writes.length} writes kept in memory (none reached the database)`);
process.exit(failed ? 1 : 0);
