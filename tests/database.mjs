// Database round trip: the visitor flows (tests/_flows.mjs) run against a
// throwaway copy of the real database, so every save goes through the real
// permissions, triggers, limits and constraints, and is then read back.
//
//   node build.mjs && node tests/database.mjs
//   needs Postgres with PostGIS, psql and postgrest (see tests/db/start.mjs; CI has them)
//
// Why: every other browser test answers a save with a pretend "saved". A
// migration that renames a column, tightens a policy or changes a limit could
// break real submissions while those tests stay green. Here the database is
// built from this repo (schema snapshot + the migrations after it, including
// any migration in the pull request being tested) and the pages really save.
//
// What is real: the built pages, PostgREST (the server Supabase runs in front
// of Postgres), every table, policy, trigger and function, and the /api/take
// Function. What is not: sign-in itself (the test hands the browser a session
// signed with this run's key) and Cloudflare's location stamp.
// Nothing here reads from or writes to a person's account on the live site;
// the public reference data (cities, questions, approved takes) is copied in
// at the start so the built pages find the same ids they were built with.
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { serveDist } from "./_serve.mjs";
import { startTestDatabase } from "./db/start.mjs";
import { visitorFlows, SB, KEY, OWNER_COLUMN, READ_ONLY_RPCS } from "./_flows.mjs";
import { onRequestPost as takeFunction } from "../functions/api/take.js";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n").slice(0, 12).join("\n      ")]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const lit = v => v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`;

let db;
try { db = await startTestDatabase(); }
catch (e) { console.log(`✗ The test database could not be built from the repo\n      ${String(e.message || e).split("\n").join("\n      ")}`); process.exit(1); }
console.log(`Test database: Postgres ${Math.floor(db.serverVersion / 10000)} at ${db.host}, schema snapshot through ${db.through} + ${db.applied.length} later migration(s)`);

// ---- the /api/take Function and anything else in this process that calls the live database with a
//      person's token is sent to the test database instead (public, signed-out reads still go to the live site) ----
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const h = init.headers || {};
  const auth = h.authorization || h.Authorization;
  if (url.startsWith(SB + "/rest/v1/") && auth && auth !== `Bearer ${KEY}`) {
    const headers = { ...h }; delete headers.apikey;
    return nativeFetch(db.rest + url.slice((SB + "/rest/v1").length), { ...init, headers });
  }
  return nativeFetch(input, init);
};
const live = async path => {
  const r = await nativeFetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } });
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error(`could not read ${path.split("?")[0]} from the live site to seed the test database: ${JSON.stringify(rows).slice(0, 200)}`);
  return rows;
};

// ---- copy the public reference data in (no triggers, no limits: this is setup, not a visitor) ----
const columnsOf = table => db.rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${lit(table)}
  and is_generated = 'NEVER' and udt_name not in ('geography', 'geometry')`).map(r => r.column_name);
function seed(table, rows, schema = "public") {
  if (!rows.length) return 0;
  const cols = (schema === "public" ? columnsOf(table) : Object.keys(rows[0])).filter(c => rows.some(r => c in r));
  const list = cols.map(c => `"${c}"`).join(", ");
  db.sql(`set session_replication_role = replica;
insert into ${schema}.${table} (${list}) select ${list} from jsonb_populate_recordset(null::${schema}.${table}, $tvseed$${JSON.stringify(rows)}$tvseed$::jsonb) on conflict do nothing;`);
  return rows.length;
}
const seeded = {};
try {
  const posts = await live("posts?select=*&status=eq.approved");
  const picks = await live("top3_picks?select=*");
  const people = [...new Set(posts.map(p => p.author_id).concat(picks.map(p => p.user_id)).filter(Boolean))];
  seeded.people = seed("users", people.map(id => ({ id, is_anonymous: false })), "auth");
  seeded.profiles = seed("profiles", people.length ? await live(`profiles?select=*&id=in.(${people.join(",")})`) : []);
  seeded.cities = seed("cities", await live("cities?select=*"));
  seeded.questions = seed("questions", await live("questions?select=*"));
  seeded.places = seed("places", await live("places?select=*"));
  seeded.posts = seed("posts", posts);
  seeded.city_events = seed("city_events", await live("city_events?select=*"));
  seeded.vibes = seed("vibes", await live("vibes?select=*"));
  seeded.restaurants = seed("restaurants", await live("restaurants?select=*"));
  seeded.top3_picks = seed("top3_picks", picks);
  // Cities people can ask for: the base table isn't public, its view is. Coordinates don't matter here.
  seeded.city_candidates = seed("city_candidates", (await live("city_request_counts?select=*")).map(c => ({ lat: 0, lng: 0, population: 0, ...c })));
  var SEED_POSTS = posts;
} catch (e) {
  console.log(`✗ The test database could not be filled with the site's public data\n      ${String(e.message || e).split("\n").join("\n      ")}`);
  await db.stop(); process.exit(1);
}
console.log(`Seeded from the live site's public data: ${Object.entries(seeded).map(([k, n]) => `${n} ${k}`).join(", ")}\n`);

// ---- the real backend ----
const writes = [], refused = [];
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const real = {
  name: "the test database",
  writes,
  read: async path => {
    const r = await nativeFetch(`${db.rest}/${path}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(`a signed-out visitor could not read ${path.split("?")[0]} from the test database: ${JSON.stringify(rows).slice(0, 200)}`);
    return rows;
  },
  async newPerson({ signedIn }) {
    const id = randomUUID(), exp = Math.floor(Date.now() / 1000) + 3600;
    const meta = signedIn ? { full_name: "Test Returning" } : {};
    // A new account, as sign-in would create it (the database then makes its profile).
    db.sql(`insert into auth.users (id, is_anonymous, raw_user_meta_data) values (${lit(id)}, ${!signedIn}, ${lit(JSON.stringify(meta))}::jsonb);`);
    const user = { id, aud: "authenticated", role: "authenticated", is_anonymous: !signedIn, app_metadata: signedIn ? { provider: "google" } : {}, user_metadata: meta, created_at: new Date().toISOString() };
    const access_token = db.token({ sub: id, role: "authenticated", is_anonymous: !signedIn, exp, app_metadata: user.app_metadata, user_metadata: meta });
    return { id, user, token: access_token, session: { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "test-" + id, user } };
  },
  async addOtherTake(row) {
    const author = randomUUID();
    db.sql(`insert into auth.users (id, is_anonymous) values (${lit(author)}, false);
set session_replication_role = replica;
insert into public.posts (id, author_id, city_id, question_id, type, title, status) values (${lit(row.id)}, ${lit(author)}, ${lit(row.city_id)}, ${lit(row.question_id)}, ${lit(row.type)}, ${lit(row.title)}, 'approved');`);
  },
  // The agreement stays in the database (it is what the check reads back); only the stand-in take is hidden again.
  removeTake: async id => { db.sql(`set session_replication_role = replica;\nupdate public.posts set status = 'rejected' where id = ${lit(id)};`); },
  stored: async (table, personId) => Number(db.sql(`select count(*) from public.${table} where ${OWNER_COLUMN[table]} = ${lit(personId)};`)),
  async attach(ctx, { id }) {
    await ctx.route(`${SB}/rest/v1/**`, async r => {
      const req = r.request(), m = req.method(), u = new URL(req.url());
      if (m === "OPTIONS") return r.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-methods": "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-headers": req.headers()["access-control-request-headers"] || "*", "access-control-max-age": "600" } });
      const headers = { ...req.headers() };
      for (const h of ["apikey", "host", "connection", "content-length", "accept-encoding"]) delete headers[h];
      if (headers.authorization === `Bearer ${KEY}`) delete headers.authorization;   // no session: the request runs as a signed-out visitor
      const name = u.pathname.split("/").pop(), rpc = u.pathname.includes("/rpc/");
      const isWrite = !["GET", "HEAD"].includes(m) && !(rpc && READ_ONLY_RPCS.includes(name));
      const target = rpc ? "rpc:" + name : name;
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
      if (isWrite) writes.push({ target, method: m, body, who: id });
      const resp = await nativeFetch(db.rest + u.pathname.replace(/^\/rest\/v1/, "") + u.search, { method: m, headers, body: ["GET", "HEAD"].includes(m) ? undefined : req.postDataBuffer() || undefined });
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!resp.ok) refused.push({ target, method: m, status: resp.status, who: id, why: buf.toString("utf8").slice(0, 300), write: isWrite });
      const out = { ...Object.fromEntries(resp.headers), ...CORS };
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) delete out[h];
      return r.fulfill({ status: resp.status, headers: out, body: buf });
    });
    await ctx.route("**/api/**", async r => {
      const req = r.request(), p = new URL(req.url()).pathname;
      if (p === "/api/take") {
        // The real Function (functions/api/take.js), as Cloudflare would run it, minus the location stamp.
        let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
        writes.push({ target: "/api/take", method: "POST", body, who: id });
        const background = [];
        const res = await takeFunction({ request: new Request("https://www.tripvibz.com/api/take", { method: "POST", headers: { authorization: req.headers().authorization || "", "content-type": "application/json" }, body: req.postData() || "{}" }),
          env: {}, waitUntil: pr => background.push(Promise.resolve(pr).catch(() => {})) });
        await Promise.all(background);
        const text = await res.text();
        if (!res.ok) refused.push({ target: "/api/take", method: "POST", status: res.status, who: id, why: text.slice(0, 300), write: true });
        return r.fulfill({ status: res.status, headers: { "content-type": "application/json" }, body: text });
      }
      if (p === "/api/locate") return r.fulfill({ json: { ok: true, near: [] } });
      if (p === "/api/near") return r.fulfill({ json: { ok: false } });
      return r.fulfill({ status: 204, body: "" });
    });
  }
};

const server = await serveDist(8093);
const BASE = "http://localhost:8093";
const browser = await chromium.launch();

let flows = null;
try { flows = await visitorFlows({ browser, BASE, backend: real, test, assert }); }
catch (e) { results.push(["FAIL", "Visitor flows could not start", String(e.message || e)]); }

if (flows) {
  const { anon, local, q1, nash, votedTake, TOP3 } = flows;
  const one = text => db.rows(text)[0];

  await test("No save a page sent was refused by the database", async () => {
    const bad = refused.filter(x => x.write);
    assert(!bad.length, `${bad.length} save(s) refused:\n      ${bad.slice(0, 6).map(x => `${x.method} ${x.target} → ${x.status} ${x.why}`).join("\n      ")}`);
  });

  await test("No read a page made was refused by the database (a missing grant or a renamed column shows up here)", async () => {
    const bad = refused.filter(x => !x.write && x.status !== 406);   // 406 = "no such row yet" on a single-row read
    assert(!bad.length, `${bad.length} read(s) refused:\n      ${[...new Set(bad.map(x => `${x.method} ${x.target} → ${x.status} ${x.why}`))].slice(0, 6).join("\n      ")}`);
  });

  await test("Read back: the answer and the take are stored as the person entered them, tied to the question, the city and their account", async () => {
    const vote = one(`select option_id from public.question_votes where user_id = ${lit(anon.id)} and question_id = ${lit(q1.id)}`);
    assert(vote && vote.option_id, "the answer to the question is not stored");
    const take = one(`select title, question_id, city_id, type, status from public.posts where author_id = ${lit(anon.id)} and title like '%REGRESSION TEST%'`);
    assert(take, "the take is not stored");
    assert(take.question_id === q1.id && take.city_id === nash.id, `the take is stored without its question or city: ${JSON.stringify(take)}`);
    assert(/go on a weekday before noon/.test(take.title), `the take's words changed on the way in: ${take.title}`);
    const mine = await (await nativeFetch(`${db.rest}/posts?select=id&author_id=eq.${anon.id}`, { headers: { authorization: `Bearer ${anon.token}` } })).json();
    assert(Array.isArray(mine) && mine.length === 1, `the person cannot read their own take back through the site's permissions: ${JSON.stringify(mine).slice(0, 200)}`);
  });

  await test("Read back: a True vote is counted on the take, a reply is counted on its page", async () => {
    const before = SEED_POSTS.find(p => p.id === votedTake);
    const after = one(`select ups, comment_count from public.posts where id = ${lit(votedTake)}`);
    assert(before && after && after.ups === before.ups + 1, `the take's True count should go from ${before && before.ups} to ${before && before.ups + 1}; it is ${after && after.ups}`);
    const replied = SEED_POSTS.slice().sort((a, b) => b.ups - a.ups)[0];
    const c = one(`select body, kind, post_id from public.comments where author_id = ${lit(anon.id)}`);
    assert(c && /REGRESSION TEST still true on weekends/.test(c.body), "the reply is not stored");
    const counted = one(`select comment_count from public.posts where id = ${lit(c.post_id)}`);
    const was = (SEED_POSTS.find(p => p.id === c.post_id) || replied).comment_count;
    assert(counted.comment_count === was + 1, `the take's reply count should go from ${was} to ${was + 1}; it is ${counted.comment_count}`);
  });

  await test("Read back: a top 3 is stored as three ranked picks of three restaurants in that city", async () => {
    const picks = db.rows(`select p.rank, r.name, c.slug from public.top3_picks p join public.restaurants r on r.id = p.restaurant_id join public.cities c on c.id = p.city_id
      where p.user_id = ${lit(local.id)} order by p.rank`);
    assert(picks.length === 3 && picks.every((p, i) => p.rank === i + 1 && p.name === TOP3[i] && p.slug === "miami"), `expected the three picks in order for Miami, got ${JSON.stringify(picks)}`);
  });

  await test("The database still says no: nobody saves as someone else, a signed-out visitor saves nothing, an anonymous session can't pick a top 3", async () => {
    const send = (path, token, body) => nativeFetch(`${db.rest}/${path}`, { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const count = text => Number(db.sql(text));
    let r = await send("votes", anon.token, { user_id: local.id, post_id: votedTake, value: 1 });
    assert(!r.ok && count(`select count(*) from public.votes where user_id = ${lit(local.id)};`) === 0, `one person saved a vote in another person's name (HTTP ${r.status})`);
    r = await send("question_votes", null, { question_id: q1.id, user_id: local.id, option_id: "x" });
    assert(!r.ok, `a signed-out visitor saved an answer (HTTP ${r.status})`);
    r = await send("posts", null, { title: "REGRESSION TEST signed out", type: "take", city_id: nash.id });
    assert(!r.ok && count(`select count(*) from public.posts where title = 'REGRESSION TEST signed out';`) === 0, `a signed-out visitor posted a take (HTTP ${r.status})`);
    const rest = one(`select id from public.restaurants where city_id = ${lit(nash.id)} limit 1`) || one(`select id from public.restaurants limit 1`);
    r = await send("top3_picks", anon.token, { user_id: anon.id, city_id: nash.id, rank: 1, restaurant_id: rest.id });
    assert(!r.ok && count(`select count(*) from public.top3_picks where user_id = ${lit(anon.id)};`) === 0, `an anonymous session saved a top 3 pick (HTTP ${r.status})`);
  });

  await flows.close();
}

await browser.close();
server.close();
await db.stop();
for (const [s, n, e] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n}${e ? `\n      ${e}` : ""}`);
const failed = results.filter(r => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed · ${writes.length} saves went to the test database (none reached the live site)`);
process.exit(failed ? 1 : 0);
