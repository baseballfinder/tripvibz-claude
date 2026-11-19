// Security checks on the repo, the built site (dist/) and the Cloudflare
// Functions. No browser, no network, fast. Runs on every pull request and
// merge (.github/workflows/tests.yml). `node build.mjs && node tests/security.mjs`
//
// What this guards, in plain words:
//   • the security headers every page is served with, and that the Functions
//     use the same definition (functions/_security.js is the one source);
//   • no script or stylesheet comes from a third-party host (everything the
//     browser runs is in this repo and content-hashed), except Google Fonts;
//   • the Content-Security-Policy lists every outside origin the site uses;
//   • no secret (database password, service key, API token, private key) is
//     committed to the repo;
//   • the GitHub workflows can't be hijacked by a pull request or an issue;
//   • the API functions reject bad input and the sign-in bridge can't be used
//     as an open redirect;
//   • database functions that run with elevated rights pin their search_path.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, String(e.message || e).split("\n")[0]]); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const exists = async p => { try { await stat(p); return true; } catch { return false; } };
async function htmlFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlFiles(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out;
}
const tracked = execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
const pages = await htmlFiles("dist");
const sec = await import("../functions/_security.js");

/* ---------------- headers ---------------- */

await test("dist/_headers carries every security header for /* and matches functions/_security.js", async () => {
  const h = await readFile("dist/_headers", "utf8");
  const block = (h.split(/\n(?=\S)/).find(b => b.startsWith("/*\n")) || "");
  for (const [k, v] of Object.entries(sec.SECURITY_HEADERS))
    assert(block.includes(`  ${k}: ${v}\n`), `/* block is missing "${k}" with the value from functions/_security.js`);
  // The asset rules must detach the generic Cache-Control, or Cloudflare sends both.
  for (const path of ["/assets/*", "/*.webp", "/*.svg"]) {
    const b = h.split(/\n(?=\S)/).find(x => x.startsWith(path + "\n")) || "";
    assert(/\n  ! Cache-Control\n/.test(b), `${path}: must start with "! Cache-Control" before its own value`);
  }
});

await test("Security header values are sound", async () => {
  const H = sec.SECURITY_HEADERS, csp = H["Content-Security-Policy"];
  const dir = name => (csp.split(";").map(s => s.trim()).find(s => s.startsWith(name + " ")) || "").slice(name.length + 1).split(/\s+/);
  assert(dir("frame-ancestors").join() === "'none'", "frame-ancestors must be 'none' (clickjacking)");
  assert(dir("object-src").join() === "'none'", "object-src must be 'none'");
  assert(dir("base-uri").join() === "'self'", "base-uri must be 'self'");
  assert(dir("default-src").join() === "'self'", "default-src must be 'self'");
  assert(!csp.includes("'unsafe-eval'"), "no 'unsafe-eval' anywhere");
  for (const d of ["script-src", "connect-src", "frame-src", "style-src"]) {
    const v = dir(d);
    assert(v.length, `${d} must be set explicitly`);
    assert(!v.some(s => s === "*" || s === "https:" || s === "http:" || s.startsWith("http://")), `${d} must list exact https origins, no wildcards or http`);
  }
  assert(!dir("script-src").includes("https://cdn.jsdelivr.net"), "the CDN is gone; scripts are self-hosted");
  assert(!dir("script-src").includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline' (inline scripts are hashed by build.mjs)");
  assert(dir("script-src").filter(s => s.startsWith("'sha256-")).length >= 5, "script-src should carry the inline-script hashes from functions/_inline-hashes.js");
  const hsts = /max-age=(\d+)/.exec(H["Strict-Transport-Security"]);
  assert(hsts && Number(hsts[1]) >= 31536000, "HSTS max-age must be at least a year");
  assert(H["X-Frame-Options"] === "DENY" && H["X-Content-Type-Options"] === "nosniff", "X-Frame-Options DENY and nosniff");
  assert(/^(strict-origin-when-cross-origin|no-referrer|same-origin)$/.test(H["Referrer-Policy"]), "Referrer-Policy must not leak full URLs");
  assert(H["Permissions-Policy"].includes("camera=()") && H["Permissions-Policy"].includes("geolocation=()"), "Permissions-Policy denies camera and geolocation");
});

await test("withSecurityHeaders() adds every header to a Function response without overriding set ones", async () => {
  const r = sec.withSecurityHeaders(new Response("x", { status: 404, headers: { "content-type": "text/html", "X-Frame-Options": "SAMEORIGIN" } }));
  assert(r.status === 404, "status kept");
  for (const k of Object.keys(sec.SECURITY_HEADERS)) assert(r.headers.get(k), `${k} missing`);
  assert(r.headers.get("X-Frame-Options") === "SAMEORIGIN", "an explicitly set header is left alone");
  assert(r.headers.get("content-type") === "text/html", "existing headers kept");
});

/* ---------------- what the browser loads ---------------- */

await test("Every script, stylesheet and font is same-origin (fonts and the Supabase client are self-hosted)", async () => {
  const styleAllow = new Set();
  for (const f of pages) {
    const h = await readFile(f, "utf8");
    for (const m of h.matchAll(/<script[^>]+src=["']([^"']+)["']/g))
      assert(!/^(https?:)?\/\//i.test(m[1]), `${f}: third-party script ${m[1]}`);
    for (const m of h.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/g)) {
      if (/^(https?:)?\/\//i.test(m[1])) assert(styleAllow.has(new URL(m[1], "https://x").hostname), `${f}: third-party stylesheet ${m[1]}`);
    }
    assert(!h.includes("cdn.jsdelivr.net") && !h.includes("unpkg.com") && !h.includes("cdnjs.cloudflare.com"), `${f}: still references a public CDN`);
    assert(!h.includes("fonts.googleapis.com") && !h.includes("fonts.gstatic.com"), `${f}: fonts must be self-hosted (build.mjs), not Google Fonts`);
  }
  assert(await exists("dist/assets/supabase.js"), "dist/assets/supabase.js (bundled from the pinned npm package) missing");
  const vendored = await readFile("dist/assets/supabase.js", "utf8");
  assert(vendored.includes("createClient") && vendored.includes("rest/v1") && vendored.includes("auth/v1") && vendored.length > 50_000, "vendored Supabase client looks wrong");
  assert(!vendored.includes("realtime/v1") && !vendored.includes("storage/v1"), "vendored Supabase client carries Realtime/Storage code the site never uses (lib/supabase-client.mjs)");
});

await test("Inline scripts: functions/_inline-hashes.js matches the built pages; no inline on*= handlers anywhere", async () => {
  const { createHash } = await import("node:crypto");
  const want = new Set();
  const htmlFiles = [];
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (p.endsWith(".html")) htmlFiles.push(p); } };
  await walk("dist");
  for (const f of htmlFiles) {
    const h = await readFile(f, "utf8");
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
      if (/\bsrc\s*=/i.test(m[1]) || /ld\+json/i.test(m[1])) continue;
      want.add(`'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`);
    }
    // on*= attributes can't be hashed into a CSP without 'unsafe-hashes'; the photo fallbacks are data-attributes.
    const handlers = h.match(/\son(error|click|load|change|input|submit|key\w+|mouse\w+|focus|blur)\s*=\s*["']/gi) || [];
    assert(!handlers.length, `${f}: inline event handler attribute ${handlers.length ? handlers[0].trim() : ""}`);
  }
  const { INLINE_SCRIPT_HASHES } = await import("../functions/_inline-hashes.js");
  const have = new Set(INLINE_SCRIPT_HASHES);
  const missing = [...want].filter(x => !have.has(x)), extra = [...have].filter(x => !want.has(x));
  assert(!missing.length && !extra.length, `functions/_inline-hashes.js is stale (run node build.mjs and commit it): missing ${missing.length}, extra ${extra.length}`);
  assert(want.size >= 5 && want.size <= 20, `${want.size} distinct inline scripts: expected one per page template (+ the head handler)`);
  // Markup built by the scripts must not carry handlers either.
  for (const f of ["assets/tv.js", "assets/v2.js", "assets/analytics.js", "build.mjs"]) {
    const js = await readFile(f, "utf8");
    const m = /\son(error|click|load)=\\?["']/i.exec(js);
    assert(!m, `${f}: generates markup with an inline ${m && m[0].trim()} handler (use data-err / data-fallback; build.mjs IMG_ERROR_SCRIPT handles them)`);
  }
});

await test("CSP covers every outside origin the site code talks to", async () => {
  const csp = sec.CSP;
  const src = (await Promise.all(["assets/tv.js", "assets/v2.js", "assets/analytics.js", "build.mjs", ...tracked.filter(f => /^[a-z0-9/-]+\.html$/.test(f))].map(f => readFile(f, "utf8")))).join("\n");
  const origins = new Set([...src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase()));
  // Navigation-only and server-side origins never need to be in the CSP.
  const notLoaded = new Set(["www.tripvibz.com", "tripvibz.com", "tripvibz.pages.dev", "schema.org", "www.sitemaps.org", "miamitake.com", "jamesoverholt.com",
    "ntfy.sh", "open.tiktokapis.com", "www.tiktok.com", "www.facebook.com", "twitter.com", "wa.me", "developers.facebook.com",
    "www.google.com", "overturemaps.org", "overturemaps-us-west-2.s3.us-west-2.amazonaws.com"]);   // link targets / build-time data, never loaded by the page
  const inCsp = o => csp.includes(`https://${o}`) || csp.includes(`https://*.${o.split(".").slice(-2).join(".")}`) || csp.includes(`https://*.${o.split(".").slice(1).join(".")}`);
  for (const o of origins) if (!notLoaded.has(o)) assert(inCsp(o), `origin ${o} is used in the code but not allowed by the CSP (functions/_security.js)`);
});

/* ---------------- secrets ---------------- */

await test("No secret committed to the repo (keys, tokens, database passwords, private keys)", async () => {
  const patterns = [
    [/sb_secret_[A-Za-z0-9_-]{10,}/, "Supabase secret key"],
    [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT (legacy service_role / access token)"],
    [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, "GitHub token"],
    [/github_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained token"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, "Stripe-style key"],
    [/xox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
    [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, "private key"],
    [/postgres(ql)?:\/\/[^:\s/]+:[^@\s]{4,}@[^\s]+/, "database URL with a password"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
    [/(?:api[_-]?key|client[_-]?secret|service[_-]?role[_-]?key|access[_-]?token)['"]?\s*[:=]\s*['"](?!sb_publishable_)[A-Za-z0-9_\-]{24,}['"]/i, "hard-coded credential assignment"]
  ];
  const skip = f => /^(package-lock\.json|assets\/og\/|assets\/brand\/|scripts\/fonts\/)/.test(f) || /\.(png|jpg|jpeg|webp|ico|ttf|pyc)$/i.test(f);
  for (const f of tracked) {
    if (skip(f)) continue;
    const s = await readFile(f, "utf8").catch(() => "");
    for (const [rx, what] of patterns) {
      const m = rx.exec(s);
      assert(!m, `${f}: looks like a ${what} (${m && m[0].slice(0, 12)}…)`);
    }
  }
});

/* ---------------- workflows ---------------- */

await test("The after-deploy check of the real site is read-only and runs after every merge", async () => {
  const src = await readFile("tests/live.mjs", "utf8");
  assert(!/method\s*:/.test(src) && !/\b(POST|PUT|PATCH|DELETE)\b/.test(src), "tests/live.mjs must only make GET requests: it runs against the real site");
  assert(!/supabase\.co|apikey|authorization/i.test(src), "tests/live.mjs talks to the site, never to the database, and carries no keys");
  const wf = await readFile(".github/workflows/live-check.yml", "utf8");
  assert(/push:\s*\n\s*branches: \[main\]/.test(wf) && /node tests\/live\.mjs/.test(wf) && /build\.json/.test(wf), "live-check.yml should wait for the merged build and then run tests/live.mjs on every merge to main");
  assert(/permissions:\s*\n\s*contents: read/.test(wf) && !/secrets\./.test(wf), "the live check needs no secrets and read-only repository access");
  assert(/seen=\$\(\(seen \+ 1\)\); else seen=0/.test(wf) && /"\$seen" -ge [3-9]/.test(wf), "live-check.yml must see the merged build several times in a row before testing: a deploy rolls out a few servers at a time, and one early match is followed by answers from the old build");
});

await test("GitHub workflows: least privilege, no pull_request_target, no untrusted text in run: scripts", async () => {
  for (const f of tracked.filter(f => f.startsWith(".github/workflows/") && f.endsWith(".yml"))) {
    const y = await readFile(f, "utf8");
    assert(!/pull_request_target/.test(y), `${f}: pull_request_target runs fork code with secrets`);
    assert(/^permissions:/m.test(y), `${f}: needs a top-level permissions: block`);
    // Issue/PR titles and bodies interpolated into a shell script are a script-injection hole.
    for (const line of y.split("\n"))
      assert(!/\$\{\{\s*github\.event\.(issue|pull_request|comment|review)\.(title|body)/.test(line), `${f}: pass ${line.trim().slice(0, 60)} through env:, not into the script`);
    if (f.endsWith("tests.yml")) assert(/permissions:\s*\n\s+contents: read\s*\n(?!\s+\w+: write)/.test(y), "tests.yml must be read-only");
  }
});

/* ---------------- Functions: input handling ---------------- */

async function withMockFetch(calls, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000000" }]), { status: 201 }); };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

await test("/api/hotels: off without the key, only takes a city slug, keeps the key in a header, passes on only the partner's links (under TripVibz's ID) and well-rated hotels, relays photos safely, and fails open", async () => {
  const mod = await import("../functions/api/hotels.js");
  const listing = (over = {}) => ({ id: "1.0", name: "Pier Hotel", url: "https://www.stay22.com/allez/roam/x?aid=someoneelse&checkin=2026-12-11", media: { thumbnail: "https://photos.booking-site.example/pier.jpg" },
    suppliers: { booking: { link: "https://www.stay22.com/allez/booking/x", price: { total: 380 } }, expedia: { price: { total: 350 } }, other: { price: null } },
    location: { coordinates: { lat: 41.89, lng: -87.61 } }, rating: { value: 8.64, hotelStars: 4, count: 1240 }, policies: { freeCancellation: true }, ...over });
  const JPEG = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  const run = async (query, env, partner, image = JPEG) => {
    const calls = [], real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/rest/v1/cities")) return new Response(JSON.stringify(query.includes("nowhere") ? [] : [{ slug: "chicago", lat: 41.88, lng: -87.63 }]), { status: 200 });
      if (String(url).startsWith("https://api.stay22.com/")) return partner();
      return image();
    };
    try { return { res: await mod.onRequestGet({ request: new Request(`https://www.tripvibz.com/api/hotels${query}`), env }), calls }; } finally { globalThis.fetch = real; }
  };
  const ok200 = () => new Response(JSON.stringify({ meta: { nights: 2 }, results: [
    listing(), listing({ name: "Elsewhere link", url: "https://evil.example/x" }), listing({ name: "Low rated", rating: { value: 7.9, count: 5000 } }),
    listing({ name: "Few reviews", rating: { value: 9.5, count: 12 } }), listing({ name: "No place", location: {} }), listing({ name: "No price", suppliers: {} }), null ] }), { status: 200 });

  // Off: no key -> 204, nobody called.
  let r = await run("?city=chicago", {}, ok200);
  assert(r.res.status === 204 && r.calls.length === 0, "without STAY22_API_KEY the function must answer 204 and call nobody");
  // Input: a slug and nothing else. Coordinates or addresses from the visitor are never used.
  for (const q of ["", "?city=", "?city=Chicago", "?city=../x", "?city=chicago%20or%201", "?lat=1&lng=2", `?city=${"a".repeat(41)}`]) {
    r = await run(q, { STAY22_API_KEY: "k" }, ok200);
    assert(r.res.status === 400 && r.calls.length === 0, `bad input ${q} should be refused before any outside call (got ${r.res.status})`);
  }
  // Dates: only a real stay, not in the past, within a year, 1 to 14 nights; anything else is refused before any outside call.
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  for (const q of [`?city=chicago&checkin=${day(10)}`, `?city=chicago&checkout=${day(10)}`, `?city=chicago&checkin=${day(10)}&checkout=${day(10)}`, `?city=chicago&checkin=${day(10)}&checkout=${day(9)}`,
    `?city=chicago&checkin=${day(-5)}&checkout=${day(-4)}`, `?city=chicago&checkin=${day(10)}&checkout=${day(30)}`, `?city=chicago&checkin=${day(400)}&checkout=${day(401)}`,
    "?city=chicago&checkin=2027-02-30&checkout=2027-03-02", "?city=chicago&checkin=tomorrow&checkout=later", `?city=chicago&checkin=${day(10)}T00:00&checkout=${day(11)}`]) {
    r = await run(q, { STAY22_API_KEY: "k" }, ok200);
    assert(r.res.status === 400 && r.calls.length === 0, `bad dates ${q} should be refused before any outside call (got ${r.res.status})`);
  }
  r = await run(`?city=chicago&checkin=${day(30)}&checkout=${day(33)}`, { STAY22_API_KEY: "k" }, ok200);
  const dated = r.calls.find(c => c.url.startsWith("https://api.stay22.com/"));
  assert(r.res.status === 200 && new URL(dated.url).searchParams.get("checkin") === day(30) && new URL(dated.url).searchParams.get("checkout") === day(33), "the visitor's dates should reach the partner");
  const datedBody = await r.res.json();
  assert(datedBody.checkin === day(30) && datedBody.checkout === day(33) && datedBody.nights === 3, `the answer says which dates it priced: ${JSON.stringify([datedBody.checkin, datedBody.checkout, datedBody.nights])}`);
  assert(datedBody.hotels[0].img === `/api/hotels?city=chicago&photo=1.0&checkin=${day(30)}&checkout=${day(33)}`, "photo paths carry the dates, so the photo is found in that list");
  assert((await run(`?city=chicago&photo=1.0&checkin=${day(30)}&checkout=${day(33)}`, { STAY22_API_KEY: "k" }, ok200)).res.status === 200, "a photo for chosen dates should load");
  r = await run("?city=nowhere", { STAY22_API_KEY: "k" }, ok200);
  assert(r.res.status === 404 && r.calls.length === 1, "a city we don't have is a 404 and the partner is not called");

  // On: the partner is asked about our city's position, with the key in a header only.
  r = await run("?city=chicago&lat=0&lng=0", { STAY22_API_KEY: "sekret-key" }, ok200);
  assert(r.res.status === 200, `expected 200 with a key, got ${r.res.status}`);
  const call = r.calls.find(c => c.url.startsWith("https://api.stay22.com/"));
  assert(call && call.init.headers["X-API-KEY"] === "sekret-key" && !call.url.includes("sekret-key"), "the key goes in the X-API-KEY header, never in the address");
  const u = new URL(call.url);
  assert(u.searchParams.get("lat") === "41.88" && u.searchParams.get("lng") === "-87.63", "position must come from our cities table, not the visitor");
  assert(u.searchParams.get("type") === "hotel" && u.searchParams.get("minguestrating") === "8" && u.searchParams.get("minratingcount") === "200", "quality floor missing from the partner request");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("checkin")) && new Date(u.searchParams.get("checkin")).getUTCDay() === 5, "prices are asked for a Friday night");
  assert(u.searchParams.get("campaign") === "tripvibz_guidehotels_chicago", "campaign tag missing");
  assert(call.init.signal, "the partner call needs a time limit");
  const body = await r.res.clone().text(), data = JSON.parse(body);
  assert(!body.includes("sekret-key"), "the key leaked into the response");
  assert(data.hotels.map(h => h.name).join("|") === "Pier Hotel|No price", `only usable, well-rated hotels with partner links pass: ${data.hotels.map(h => h.name)}`);
  const h = data.hotels[0];
  assert(h.price === 175 && h.rating === 8.6 && h.reviews === 1240 && h.stars === 4 && h.cancel === true, `lowest total divided by nights, rounded rating: ${JSON.stringify(h)}`);
  assert(data.hotels[1].price === null, "a hotel with no price is 'unknown', never $0");
  const listCache = r.res.headers.get("cache-control");
  // Every link books under TripVibz's own ID, whatever ID the key belongs to.
  assert(data.hotels.every(x => new URL(x.url).searchParams.get("aid") === "tripvibz") && !body.includes("someoneelse"), `a link left with another affiliate ID: ${data.hotels[0].url}`);
  assert(new URL(h.url).searchParams.get("checkin") === "2026-12-11", "the rest of the partner's link is kept");
  // Photos: the page gets our own path, never the booking site's address.
  assert(h.img === "/api/hotels?city=chicago&photo=1.0" && !body.includes("booking-site.example") && !("thumb" in h), `photo path: ${h.img}`);
  r = await run("?city=chicago&photo=1.0", { STAY22_API_KEY: "k" }, ok200);
  assert(r.res.status === 200 && r.res.headers.get("content-type") === "image/jpeg" && r.res.headers.get("x-content-type-options") === "nosniff", `photo should pass through as an image, got ${r.res.status} ${r.res.headers.get("content-type")}`);
  assert(/max-age=3600/.test(r.res.headers.get("cache-control")), "photos are cached for 60 minutes at most");
  const imgCall = r.calls.find(c => c.url.startsWith("https://photos.booking-site.example/"));
  assert(imgCall && imgCall.init.signal && !JSON.stringify(imgCall.init.headers || {}).includes("k\""), "the photo fetch needs a time limit and must not carry the key");
  assert((await run("?city=chicago&photo=9.9", { STAY22_API_KEY: "k" }, ok200)).res.status === 404, "only hotels in the city's list can be asked for");
  for (const q of ["?city=chicago&photo=", "?city=chicago&photo=https://evil.example/x.jpg", "?city=chicago&photo=../x"]) {
    r = await run(q, { STAY22_API_KEY: "k" }, ok200);
    assert(r.res.status === 400 && r.calls.length === 0, `bad photo id ${q} should be refused before any outside call`);
  }
  for (const image of [() => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }), () => new Response("x", { status: 500 }),
    () => new Response(new Uint8Array(1600000), { status: 200, headers: { "content-type": "image/jpeg" } }), () => { throw new Error("down"); }]) {
    assert((await run("?city=chicago&photo=1.0", { STAY22_API_KEY: "k" }, ok200, image)).res.status === 404, "anything that isn't a reasonably sized image is a 404");
  }
  assert((await run("?city=chicago&photo=1.0", {}, ok200)).res.status === 204, "photos are off without the key too");
  assert(/s-maxage=3600/.test(listCache) && !/s-maxage=(3[7-9]|[4-9])\d{3}/.test(listCache), "the partner allows caching for 60 minutes at most");

  // Fail open: partner down, slow, or answering nonsense -> 204, the Guide stays as it was.
  for (const partner of [() => new Response("no", { status: 502 }), () => new Response("{", { status: 200 }), () => { throw new Error("down"); }, () => new Response(JSON.stringify({ results: [] }), { status: 200 })]) {
    r = await run("?city=chicago", { STAY22_API_KEY: "k" }, partner);
    assert(r.res.status === 204, `a partner failure should answer 204, got ${r.res.status}`);
  }
  const src = await readFile("functions/api/hotels.js", "utf8");
  assert(!/\.(insert|upsert)\(|method:\s*"(POST|PATCH|PUT)"/.test(src), "hotel listings must not be stored (partner terms)");
  const d = mod.stayDates(new Date("2026-11-18T08:00:00Z"));
  assert(d.checkin === "2026-12-11" && d.checkout === "2026-12-12" && d.nights === 1, `stayDates: first Friday at least 3 weeks out, one night: ${JSON.stringify(d)}`);
});

await test("/api/take rejects missing auth, oversize or malformed input before touching the database", async () => {
  const mod = await import("../functions/api/take.js");
  const id = "11111111-1111-1111-1111-111111111111";
  const call = async (body, auth = "Bearer t") => {
    const calls = [];
    const res = await withMockFetch(calls, () => mod.onRequestPost({
      request: new Request("https://www.tripvibz.com/api/take", { method: "POST", headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }),
      env: {}, waitUntil: () => {}
    }));
    return { status: res.status, error: (await res.json()).error, dbCalls: calls.length };
  };
  const expect = async (body, auth, status, error) => {
    const r = await call(body, auth);
    assert(r.status === status && r.error === error, `${JSON.stringify(body).slice(0, 60)} -> ${r.status} ${r.error}, wanted ${status} ${error}`);
    if (status !== 200) assert(r.dbCalls === 0, `rejected input must not reach the database (${r.dbCalls} calls)`);
  };
  await expect({ title: "ok title", type: "take", city_id: id }, null, 401, "not_signed_in");
  await expect({ title: "x".repeat(mod.TITLE_MAX + 1), type: "take", city_id: id }, undefined, 400, "bad_title");
  await expect({ title: "ok title", body: "x".repeat(mod.BODY_MAX + 1), type: "take", city_id: id }, undefined, 400, "bad_body");
  await expect({ title: "ok title", type: "not_a_type", city_id: id }, undefined, 400, "bad_type");
  await expect({ title: "ok title", type: "take", city_id: "1 or 1=1" }, undefined, 400, "bad_id");
  await expect({ title: ["array"], type: "take", city_id: id }, undefined, 400, "bad_title");
  const ok = await call({ title: "ok title", type: "take", city_id: id, place_label: "x".repeat(500), topic: "y".repeat(500) });
  assert(ok.status === 200 && ok.dbCalls === 1, "a valid take is inserted");
});

await test("TikTok sign-in bridge: next= can't be an open redirect; mismatched state never reaches TikTok", async () => {
  const { safeNext } = await import("../functions/api/auth/tiktok/_shared.js");
  for (const bad of ["//evil.com", "https://evil.com/x", "http://evil.com", "/\\evil.com", "javascript:alert(1)", "\\\\evil.com", "/%2F%2Fevil.com/".replace(/%2F/g, "/"), "", null, 42])
    assert(safeNext(bad) === "/", `safeNext(${JSON.stringify(bad)}) should fall back to "/" (got ${safeNext(bad)})`);
  assert(safeNext("/miami/?x=1&y=2") === "/miami/?x=1&y=2", "a normal same-site path is kept");
  const cb = await import("../functions/api/auth/tiktok/callback.js");
  const calls = [];
  const res = await withMockFetch(calls, () => cb.onRequestGet({
    request: new Request("https://www.tripvibz.com/api/auth/tiktok/callback?code=abc&state=attacker", { headers: { cookie: "tt_state=real; tt_next=%2Fmiami%2F" } }),
    env: { TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s", SUPABASE_SERVICE_ROLE_KEY: "x" }
  }));
  assert(res.status === 302 && /signin=tiktok_failed/.test(res.headers.get("location")), "state mismatch must bounce back as tiktok_failed");
  assert(calls.length === 0, "no token exchange on a state mismatch");
});

await test("/api/log: bots, other sites' pages, foreign scripts' errors and malformed entries are dropped; a real entry is stored with the secret key and cut to size", async () => {
  const mod = await import("../functions/api/log.js");
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1";
  const post = async (body, { ua = UA, origin = "https://www.tripvibz.com", raw } = {}) => {
    const calls = [], waits = [];
    const res = await withMockFetch(calls, () => mod.onRequestPost({
      request: new Request("https://www.tripvibz.com/api/log", { method: "POST", headers: { "user-agent": ua, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: raw ?? JSON.stringify(body) }),
      env: { NTFY_TOPIC: "t", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" }, waitUntil: p => waits.push(p) }));
    await withMockFetch(calls, () => Promise.all(waits));
    assert(res.status === 204 && (await res.text()) === "", "always 204 with nothing in it");
    const saved = calls.filter(c => c.url.includes("/rest/v1/site_log"));
    return { row: saved[0] ? JSON.parse(saved[0].init.body) : null, headers: saved[0] ? saved[0].init.headers : null, pushed: calls.some(c => c.url.includes("ntfy.sh")), calls: calls.length };
  };
  const sid = "abcdefgh12345678";
  const dropped = async (why, body, opts) => { const r = await post(body, opts); assert(r.calls === 0, `${why}: should store and push nothing, made ${r.calls} call(s)`); };
  await dropped("a bot", { k: "page", first: true, sid, path: "/miami/" }, { ua: "Googlebot/2.1" });
  await dropped("another site's page", { k: "page", first: true, sid, path: "/miami/" }, { origin: "https://evil.example" });
  await dropped("not JSON", null, { raw: "<xml/>" });
  await dropped("a made-up kind", { k: "visit", sid, path: "/miami/" });
  await dropped("a non-path page", { k: "page", sid, path: "javascript:alert(1)" });
  await dropped("another host as the page", { k: "page", sid, path: "//evil.example/x" });
  await dropped("an extension's error", { k: "error", sid, path: "/miami/", msg: "x is not defined", src: "chrome-extension://abc/content.js:1", stack: "at chrome-extension://abc/content.js:1" });
  await dropped("a failed request with a made-up target", { k: "request_failed", sid, path: "/miami/", target: "POST votes; drop table", status: 500 });

  const visit = await post({ k: "page", first: true, sid, path: "/miami/", ref: "https://www.bing.com/search?q=miami+in+july", tag: "" });
  assert(visit.row && visit.row.kind === "visit" && visit.row.session_id === sid && visit.row.device === "phone" && visit.row.source === 'Bing · searched "miami in july"' && visit.pushed, `a visit is stored and pushed: ${JSON.stringify(visit)}`);
  assert(visit.headers.apikey === "sb_secret_test" && !visit.headers.authorization, "new secret keys go on the apikey header only");
  assert(!("ip" in visit.row) && !JSON.stringify(visit.row).includes("Mozilla"), "no IP and no browser string in a row");
  const page = await post({ k: "page", sid, path: "/miami/add/", ref: "https://x.example/", tag: "t" });
  assert(page.row.kind === "page" && page.row.source === null && !page.pushed, "a later page is stored without a source and without a push");
  const leave = await post({ k: "leave", sid, path: "/miami/", ms: 41234.6 });
  assert(leave.row.kind === "leave" && leave.row.ms === 41235 && leave.row.detail === null && !leave.pushed, "a leave stores the time on the page");
  const rec = await post({ k: "leave", sid, path: "/miami/", ms: 1000, rec: "yc5trg/7a3hd8" });
  assert(rec.row.detail === "https://clarity.microsoft.com/player/xpi9uwoqof/yc5trg/7a3hd8", "a leave with Clarity ids stores the recording's address on TripVibz's Clarity project");
  for (const bad of ["../../evil", "yc5trg/7a3hd8/extra", "https://evil.example/x", "a/b", "YC5TRG/7A3HD8", "yc5trg/7a3hd8?x=1", 42])
    assert((await post({ k: "leave", sid, path: "/miami/", ms: 1000, rec: bad })).row.detail === null, `a malformed recording id (${bad}) must not be stored`);
  const own = await post({ k: "error", sid, path: "/miami/", msg: "TypeError: boom " + "x".repeat(900), src: "https://www.tripvibz.com/assets/tv.js?v=abc:12", stack: "TypeError: boom\n at https://www.tripvibz.com/assets/tv.js?v=abc:12:3" });
  assert(own.row.kind === "error" && own.row.message.length === 300 && own.row.detail.length <= 800 && own.pushed, "our own script's error is stored, cut to size, and pushed");
  const fail = await post({ k: "request_failed", sid, path: "/miami/add/", target: "POST question_votes", status: 403, msg: "new row violates row-level security policy" });
  assert(fail.row.kind === "request_failed" && fail.row.detail === "POST question_votes" && fail.row.status === 403 && fail.pushed, "a failed save is stored and pushed");
  const big = await post(null, { raw: JSON.stringify({ k: "page", sid, path: "/miami/", pad: "x".repeat(5000) }) });
  assert(big.calls === 0, "a body over 2 KB is cut, no longer parses, and is dropped");
  const nosid = await post({ k: "page", first: true, sid: "'; drop table site_log;--", path: "/miami/" });
  assert(nosid.row && nosid.row.session_id === null, "a malformed visit id is not stored");
});

await test("/api/event validates every field before the database; /api/health behaves", async () => {
  const ev = await import("../functions/api/event.js");
  const id = "11111111-1111-1111-1111-111111111111";
  const good = { city_id: id, city_name: "Miami", name: "Art Basel", blurb: "Hotels fill", severity: "busy", start_month: 12, end_month: 12 };
  const call = async (body, auth = "Bearer t") => {
    const calls = [];
    const res = await withMockFetch(calls, () => ev.onRequestPost({
      request: new Request("https://www.tripvibz.com/api/event", { method: "POST", headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }),
      env: {}, waitUntil: () => {}
    }));
    return { status: res.status, error: (await res.json()).error, dbCalls: calls.length };
  };
  const bad = async (patch, error) => { const r = await call({ ...good, ...patch }); assert(r.status === 400 && r.error === error && r.dbCalls === 0, `${JSON.stringify(patch)} -> ${r.status} ${r.error} (${r.dbCalls} db calls), wanted 400 ${error}`); };
  assert((await call(good, null)).status === 401, "no token -> 401");
  await bad({ city_id: "x" }, "bad_id"); await bad({ name: "ab" }, "bad_name"); await bad({ name: "x".repeat(121) }, "bad_name");
  await bad({ severity: "meh" }, "bad_severity"); await bad({ start_month: 13 }, "bad_months"); await bad({ blurb: "x".repeat(401) }, "bad_blurb");
  const ok = await call(good); assert(ok.status === 200 && ok.dbCalls === 1, "a valid entry is inserted");

  const health = await import("../functions/api/health.js");
  const up = await withMockFetch([], () => health.onRequestGet({}));
  assert(up.status === 200 && (await up.json()).ok === true, "health: 200 when the database answers");
  const real = globalThis.fetch; globalThis.fetch = async () => { throw new Error("down"); };
  try { const down = await health.onRequestGet({}); assert(down.status === 503, "health: 503 when the database is unreachable"); } finally { globalThis.fetch = real; }

});

await test("/t/<id> returns a real 404 with security headers for a malformed id", async () => {
  const mod = await import("../functions/t/[id].js");
  const env = { ASSETS: { fetch: async () => new Response("<html><head><title>x</title></head><body><main id=\"root\"></main></body></html>", { headers: { "content-type": "text/html" } }) } };
  const res = await mod.onRequestGet({ params: { id: "../../etc/passwd" }, request: new Request("https://www.tripvibz.com/t/x"), env });
  assert(res.status === 404, `wanted 404, got ${res.status}`);
  assert(res.headers.get("Content-Security-Policy") && res.headers.get("X-Frame-Options") === "DENY", "Function HTML responses carry the security headers");
});

/* ---------------- database code in the repo ---------------- */

await test("Every SECURITY DEFINER function in a migration pins search_path (no search-path hijacking)", async () => {
  for (const f of tracked.filter(f => /^supabase\/(migrations|applied-by-hand)\/.*\.sql$/.test(f))) {
    const s = (await readFile(f, "utf8")).toLowerCase();
    for (const m of s.matchAll(/create\s+(or\s+replace\s+)?function\s+([\w.]+)[\s\S]*?(?=create\s+(or\s+replace\s+)?function|$)/g)) {
      const body = m[0];
      if (/security\s+definer/.test(body)) assert(/set\s+search_path/.test(body), `${f}: ${m[2]} is SECURITY DEFINER without "set search_path"`);
    }
  }
});

for (const r of results) console.log(r.join("  "));
await test("CSP lets the service worker run (worker-src or script-src allows 'self') and nothing else", async () => {
  const { CSP } = await import("../functions/_security.js");
  const dir = name => (CSP.split(";").map(x => x.trim()).find(x => x.startsWith(name + " ")) || "").slice(name.length + 1);
  const worker = dir("worker-src") || dir("child-src") || dir("script-src");
  assert(/(^|\s)'self'(\s|$)/.test(worker), "the directive that governs workers must allow 'self' or sw.js cannot register");
  assert(!/worker-src[^;]*(\*|https?:)/.test(CSP), "worker-src must not allow remote workers");
});

const failed = results.filter(r => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
