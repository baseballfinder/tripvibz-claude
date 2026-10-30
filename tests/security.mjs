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
  const notLoaded = new Set(["www.tripvibz.com", "tripvibz.com", "tripvibz.pages.dev", "schema.org", "www.sitemaps.org", "miamitake.com",
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

await test("/api/hit ignores bots and non-search referrers without notifying", async () => {
  const mod = await import("../functions/api/hit.js");
  const calls = [];
  const req = (ua, ref) => new Request("https://www.tripvibz.com/api/hit", { method: "POST", headers: { "user-agent": ua, "content-type": "application/json" }, body: JSON.stringify({ path: "/miami/", ref }) });
  for (const [ua, ref] of [["Googlebot/2.1", "https://www.google.com/"], ["Mozilla/5.0", "https://evil.example/"], ["Mozilla/5.0", "not a url"]]) {
    const res = await withMockFetch(calls, () => mod.onRequestPost({ request: req(ua, ref), env: { NTFY_TOPIC: "t" }, waitUntil: p => p }));
    assert(res.status === 204, "always 204");
  }
  assert(calls.length === 0, "no notification for bots or non-search visits");
});

await test("/api/event validates every field before the database; /api/health and /api/error behave (no spam from foreign scripts)", async () => {
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

  const er = await import("../functions/api/error.js");
  const beacon = async body => { const calls = []; const res = await withMockFetch(calls, () => er.onRequestPost({ request: new Request("https://www.tripvibz.com/api/error", { method: "POST", body: JSON.stringify(body) }), env: { NTFY_TOPIC: "t" }, waitUntil: p => p })); await new Promise(r => setTimeout(r, 10)); return { status: res.status, notified: calls.some(c => c.url.includes("ntfy.sh")) }; };
  const foreign = await beacon({ message: "x is not defined", source: "chrome-extension://abc/content.js:1", stack: "at chrome-extension://abc/content.js:1", page: "/miami/" });
  assert(foreign.status === 204 && !foreign.notified, "an extension's error must not notify");
  const own = await beacon({ message: "TypeError: boom", source: "https://www.tripvibz.com/assets/tv.js?v=abc:12", stack: "TypeError: boom\n at https://www.tripvibz.com/assets/tv.js?v=abc:12:3", page: "/miami/" });
  assert(own.status === 204 && own.notified, "our own script's error notifies");
  const nopage = await beacon({ message: "boom", stack: "https://www.tripvibz.com/assets/tv.js", page: "javascript:alert(1)" });
  assert(!nopage.notified, "a non-path page value is dropped");
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
const failed = results.filter(r => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
