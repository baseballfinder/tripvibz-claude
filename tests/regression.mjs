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
//   The flows live in tests/_flows.mjs. Here their writes go to an in-memory
//   copy that answers later reads the way the database would, so this suite
//   runs anywhere and never touches the live database. tests/database.mjs runs
//   the same flows against a throwaway copy of the real database.
//   The list in _flows.mjs (COMES_BACK / NOTHING_TO_SHOW) must name every write
//   the pages make, so a new write path fails until it has a check or a reason.
import { chromium } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serveDist } from "./_serve.mjs";
import { visitorFlows, SB, KEY, VIEW, OWNER_COLUMN, READ_ONLY_RPCS, COMES_BACK } from "./_flows.mjs";

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
const MEMORY_TABLES = COMES_BACK.filter(t => OWNER_COLUMN[t]);
const store = Object.fromEntries(MEMORY_TABLES.map(t => [t, []]));
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
const REMOVED = await readFile("data/removed-cities.json", "utf8").then(JSON.parse).catch(() => ({}));

const memory = {
  name: "the in-memory copy",
  writes,
  // Reads come from the live site, as a signed-out visitor sees them.
  read: async path => { const rows = await api(path); return path.startsWith("cities?") ? rows.filter(c => !REMOVED[c.slug]) : rows; },
  async newPerson({ signedIn }) {
    const id = randomUUID(), exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: id, role: "authenticated", is_anonymous: !signedIn, exp, aud: "authenticated" })}.sig`;
    const user = { id, aud: "authenticated", role: "authenticated", is_anonymous: !signedIn, app_metadata: signedIn ? { provider: "google" } : {}, user_metadata: signedIn ? { full_name: "Test Returning" } : {}, created_at: new Date().toISOString() };
    return { id, user, session: { access_token: jwt, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "test-" + id, user } };
  },
  addOtherTake: async row => { store.posts.push({ created_at: new Date().toISOString(), ...POST_DEFAULTS, author_id: randomUUID(), ...row }); },
  removeTake: async id => { store.posts = store.posts.filter(x => x.id !== id); },
  stored: async (table, personId) => store[table].filter(x => x[OWNER_COLUMN[table]] === personId).length,
  async attach(ctx, { id }) {
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
      if (m === "GET") {
        if (!store[name]) return r.continue({ headers });
        let live = null, data = [];
        try { live = await r.fetch({ headers }); data = await live.json(); } catch {}
        const mine = store[name].filter(rowFilter(url));
        if (single) return mine.length ? r.fulfill({ json: mine[0] }) : live ? r.fulfill({ response: live }) : r.fulfill({ status: 406, json: {} });
        return r.fulfill({ json: (Array.isArray(data) ? data : []).concat(mine) });
      }
      if (m === "HEAD") return r.continue({ headers });
      writes.push({ target: name, method: m, body, who: id });
      if (!store[name]) return r.fulfill({ status: 200, json: [] });   // a write to a table not copied here: recorded, kept off the live site
      let rows = [];
      if (m === "POST") {
        const conflict = (new URL(url).searchParams.get("on_conflict") || "").split(",").filter(Boolean);
        rows = (Array.isArray(body) ? body : [body]).map(x => {
          const row = { id: randomUUID(), created_at: new Date().toISOString(), ...(name === "posts" ? POST_DEFAULTS : {}), [OWNER_COLUMN[name]]: id, ...x };
          const i = conflict.length ? store[name].findIndex(o => conflict.every(c => String(o[c]) === String(row[c]))) : -1;
          if (i >= 0) { store[name][i] = { ...store[name][i], ...x }; return store[name][i]; }
          store[name].push(row); return row;
        });
      } else if (m === "DELETE") {
        const hit = rowFilter(url); rows = store[name].filter(hit);
        store[name] = store[name].filter(x => !hit(x));
      } else if (m === "PATCH") {
        rows = store[name].filter(rowFilter(url)); rows.forEach(x => Object.assign(x, body));
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
  }
};

if (ONLY !== "build") {
  let flows = null;
  try { flows = await visitorFlows({ browser, BASE, backend: memory, test, assert }); }
  catch (e) { results.push(["FAIL", "Visitor flows could not start", String(e.message || e)]); }
  if (flows) await flows.close();
}

await browser.close();
server.close();
for (const [s, n, e] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n}${e ? `\n      ${e}` : ""}`);
const failed = results.filter(r => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed · ${writes.length} writes kept in memory (none reached the database)`);
process.exit(failed ? 1 : 0);
