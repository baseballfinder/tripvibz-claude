/**
 * After-deploy check of the real site. Read-only: every request is a GET.
 *
 *   node tests/live.mjs                          # checks https://www.tripvibz.com
 *   BASE=https://<branch>.tripvibz.pages.dev node tests/live.mjs
 *   EXPECT_BUILD=<commit> node tests/live.mjs    # also insists the site serves that build
 *
 * Why it exists: the other suites test the build on a test machine, with outside
 * services faked. Things that only go wrong on the real site passed all of them:
 * hotel photos read from the wrong field of the partner's answer, hotel links
 * carrying another site's affiliate ID, a key saved for one environment only.
 * This asks the deployed site itself.
 *
 * Runs after every merge to main (.github/workflows/live-check.yml), once the
 * live site reports the merged commit as its build.
 */
const BASE = (process.env.BASE || "https://www.tripvibz.com").replace(/\/$/, "");
const EXPECT = (process.env.EXPECT_BUILD || "").trim();
const HOTELS = process.env.LIVE_HOTELS !== "off";   // previews have no partner key: LIVE_HOTELS=off skips those checks
const CITY = "chicago";

let pass = 0, fail = 0; const warnings = [];
function assert(ok, msg) { if (!ok) throw new Error(msg); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message || e).slice(0, 600)}`); }
}
async function get(path, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.ms || 25000);
  try { return await fetch(path.startsWith("http") ? path : BASE + path, { redirect: opts.redirect || "follow", signal: ctl.signal, headers: { "user-agent": "tripvibz-live-check" } }); }
  finally { clearTimeout(t); }
}
const iso = d => d.toISOString().slice(0, 10);
const inDays = n => iso(new Date(Date.now() + n * 86400000));

console.log(`Live check of ${BASE}${EXPECT ? ` (expecting build ${EXPECT.slice(0, 12)})` : ""}`);

let build = "";
await test("The site says which build it is, and it is the one just merged", async () => {
  const r = await get(`/build.json?t=${Date.now()}`);
  assert(r.status === 200, `/build.json answered ${r.status}`);
  const info = await r.json(); build = info.build;
  assert(/^[0-9a-f]{12}$/.test(build) && !Number.isNaN(Date.parse(info.built_at)), `unexpected build.json: ${JSON.stringify(info)}`);
  if (EXPECT) assert(EXPECT.startsWith(build) || build.startsWith(EXPECT.slice(0, 12)), `live build is ${build}, expected ${EXPECT.slice(0, 12)}`);
});

await test("Main pages load and every one is from the same build", async () => {
  for (const p of ["/", "/cities/", `/${CITY}/`, `/${CITY}/worst-times-to-visit/`, `/${CITY}/add/`, "/about/", "/contact/", "/privacy/", "/terms/", "/how-we-verify-locals/"]) {
    const r = await get(p); const html = await r.text();
    assert(r.status === 200, `${p} answered ${r.status}`);
    const m = html.match(/id="tv-build" data-build="([^"]+)"/);
    assert(m && m[1] === build, `${p}: footer build is ${m ? m[1] : "missing"}, site build is ${build}`);
  }
  const missing = await get("/this-page-does-not-exist-xyz/");
  assert(missing.status === 404, `a page that doesn't exist should answer 404, got ${missing.status}`);
});

await test("Security headers are on the real responses", async () => {
  const r = await get("/"); const csp = r.headers.get("content-security-policy") || "";
  const script = (csp.match(/script-src[^;]*/) || [""])[0];
  assert(script && !script.includes("'unsafe-inline'"), `script-src missing or allows inline scripts: ${script || "(none)"}`);
  assert((r.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff", "x-content-type-options: nosniff missing");
});

await test("The health check, sitemap and a share card answer", async () => {
  const h = await get("/api/health"); assert(h.status === 200, `/api/health answered ${h.status}`);
  const s = await get("/sitemap.xml"); const xml = await s.text();
  assert(s.status === 200 && xml.includes(`/${CITY}/`) && xml.includes("/contact/"), "sitemap is missing a city or the contact page");
  assert(!/knoxville|asheville/i.test(xml), "sitemap lists a removed city");
  const card = await get(`/assets/og/${CITY}.jpg`);
  assert(card.status === 200 && /^image\/jpeg/.test(card.headers.get("content-type") || ""), `share card answered ${card.status} ${card.headers.get("content-type")}`);
});

if (HOTELS) {
  let hotels = [];
  await test("Guide hotels: the real partner answers, every link books under TripVibz, hotels meet the quality floor and carry photos and prices", async () => {
    const r = await get(`/api/hotels?city=${CITY}`);
    assert(r.status === 200, `/api/hotels answered ${r.status}${r.status === 204 ? " (off: the key is missing in this environment, or the partner is down)" : ""}`);
    const d = await r.json(); hotels = d.hotels || [];
    assert(hotels.length >= 5, `only ${hotels.length} hotels came back`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(d.checkin) && new Date(d.checkin).getUTCDay() === 5 && d.nights === 1, `default stay should be one Friday night: ${d.checkin} to ${d.checkout}`);
    for (const h of hotels) {
      const u = new URL(h.url);
      assert(u.protocol === "https:" && /(^|\.)stay22\.com$/.test(u.hostname), `${h.name}: link goes to ${u.hostname}`);
      assert(u.searchParams.get("aid") === "tripvibz", `${h.name}: link carries affiliate ID "${u.searchParams.get("aid")}", not tripvibz`);
      assert(h.rating >= 8 && h.reviews >= 200, `${h.name}: below the quality floor (${h.rating}, ${h.reviews} reviews)`);
      assert(!("thumb" in h) && (!h.img || h.img.startsWith("/api/hotels?")), `${h.name}: a photo address from outside leaked (${h.img})`);
    }
    const withPhoto = hotels.filter(h => h.img).length, withPrice = hotels.filter(h => h.price > 0).length;
    assert(withPhoto >= hotels.length / 2, `only ${withPhoto} of ${hotels.length} hotels have a photo`);
    assert(withPrice >= hotels.length / 2, `only ${withPrice} of ${hotels.length} hotels have a price`);
  });

  await test("Guide hotels: a hotel's photo comes through our own server as an image", async () => {
    const h = hotels.find(x => x.img); assert(h, "no hotel with a photo to try");
    const r = await get(h.img); const bytes = (await r.arrayBuffer()).byteLength;
    assert(r.status === 200 && /^image\/(jpeg|png|webp|avif)/.test(r.headers.get("content-type") || "") && bytes > 1000, `photo answered ${r.status} ${r.headers.get("content-type")} ${bytes} bytes`);
    const unknown = await get(`/api/hotels?city=${CITY}&photo=not-a-hotel`);
    assert(unknown.status === 404, `a photo for a hotel that isn't in the list should be 404, got ${unknown.status}`);
  });

  await test("Guide hotels: picked dates are priced, and dates that make no sense are refused", async () => {
    const a = inDays(45), b = inDays(47);
    const r = await get(`/api/hotels?city=${CITY}&checkin=${a}&checkout=${b}`);
    assert(r.status === 200, `a two-night stay answered ${r.status}`);
    const d = await r.json();
    assert(d.checkin === a && d.checkout === b && d.nights === 2 && d.hotels.length >= 5, `asked ${a} to ${b}, got ${d.checkin} to ${d.checkout}, ${d.hotels.length} hotels`);
    assert(d.hotels.every(h => new URL(h.url).searchParams.get("aid") === "tripvibz"), "a dated link carries another affiliate ID");
    for (const q of [`checkin=${inDays(-10)}&checkout=${inDays(-9)}`, `checkin=${a}&checkout=${a}`, `checkin=${a}&checkout=${inDays(90)}`, "checkin=soon&checkout=later"]) {
      const bad = await get(`/api/hotels?city=${CITY}&${q}`);
      assert(bad.status === 400, `${q} should be refused with 400, got ${bad.status}`);
    }
    assert((await get("/api/hotels?city=Not%20A%20City")).status === 400, "a malformed city should be refused with 400");
  });
}

// Known gap, reported but not failed: the address without "www" still points at the old host
// (James is moving the domain's DNS). Turn this into a test once that is done.
try {
  const bare = await get(BASE.replace("://www.", "://") + `/${CITY}/`, { ms: 15000 });
  if (BASE.includes("://www.") && bare.status !== 200) warnings.push(`${BASE.replace("://www.", "://")}/${CITY}/ answers ${bare.status}: links without "www" don't work yet`);
} catch (e) { if (BASE.includes("://www.")) warnings.push(`the address without "www" doesn't answer (${String(e.message || e).slice(0, 80)})`); }

for (const w of warnings) console.log(`  warn  ${w}`);
console.log(`\n${pass}/${pass + fail} passed${warnings.length ? ` · ${warnings.length} warning(s)` : ""} · read-only, nothing was written`);
process.exit(fail ? 1 : 0);
