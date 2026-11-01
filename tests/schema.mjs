// Structured data (schema.org JSON-LD) checks on the built site and the
// function-rendered take page. `node build.mjs && node tests/schema.mjs`
//
// What this guards, in plain words:
//   • every @type and every property is a real schema.org term, and the
//     property is allowed on that type (checked against the live vocabulary;
//     if schema.org is unreachable that one check is skipped with a warning);
//   • every {"@id": …} reference resolves to a node ON THE SAME PAGE — Google
//     validates one page at a time, so an author that only exists on the home
//     page is an author with no name;
//   • the fields Google's rich-result docs require for Article, BreadcrumbList,
//     ItemList, DiscussionForumPosting, Organization and WebSite are present
//     and well-formed (absolute https URLs, ISO dates not in the future,
//     sequential positions, no empty values);
//   • the page's canonical URL matches the structured data's URL.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SITE = "https://www.tripvibz.com";
const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

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

/* ---------------- collect every page's graph ---------------- */

function blocksOf(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
}
const nodesOf = blocks => blocks.flatMap(b => b["@graph"] || [b]);
const pages = [];   // { file, url, canonical, html, blocks, nodes, kind }
for (const f of await htmlFiles("dist")) {
  const html = await readFile(f, "utf8");
  const blocks = blocksOf(html);
  if (!blocks.length) continue;
  const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
  const kind = f === "dist/index.html" ? "home" : f === "dist/cities/index.html" ? "cities"
    : /^dist\/[^/]+\/index\.html$/.test(f) ? "city" : /^dist\/[^/]+\/[^/]+\/index\.html$/.test(f) ? "topic" : "other";
  pages.push({ file: f, canonical, html, blocks, nodes: nodesOf(blocks), kind });
}

// Minimal stand-in for Cloudflare's HTMLRewriter (Node has none): supports the
// element handlers functions/t/[id].js uses — setInnerContent and append on a
// "tag" or "tag#id" selector — which is all that's needed to render the page.
globalThis.HTMLRewriter ??= class {
  constructor() { this.handlers = []; }
  on(selector, handler) { this.handlers.push([selector, handler]); return this; }
  transform(res) {
    const run = async () => {
      let html = await res.text();
      for (const [sel, h] of this.handlers) {
        const [, tag, id] = sel.match(/^([a-z0-9]+)(?:#([\w-]+))?$/i) || [];
        const open = new RegExp(`<${tag}\\b${id ? `[^>]*\\bid="${id}"` : ""}[^>]*>`, "i");
        const m = open.exec(html); if (!m) continue;
        const start = m.index + m[0].length, close = html.indexOf(`</${tag}>`, start);
        let inner = html.slice(start, close);
        const el = { setInnerContent(c) { inner = c; }, append(c) { inner += c; }, prepend(c) { inner = c + inner; } };
        h.element(el);
        html = html.slice(0, start) + inner + html.slice(close);
      }
      return html;
    };
    const stream = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await run())); c.close(); } });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
};

// The shared-take page is rendered by a Cloudflare Function; run it here on a real take.
await test("Take page (/t/<id>, Cloudflare Function) emits DiscussionForumPosting + BreadcrumbList for a real take", async () => {
  const posts = await (await fetch(`${SB}/rest/v1/posts?select=id&status=eq.approved&order=created_at.desc&limit=1`, { headers: { apikey: KEY } })).json();
  assert(Array.isArray(posts) && posts[0], "no approved take to test with");
  const mod = await import("../functions/t/[id].js");
  const shell = await readFile("dist/thread.html", "utf8");
  const env = { ASSETS: { fetch: async () => new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } }) } };
  const res = await mod.onRequestGet({ params: { id: posts[0].id }, request: new Request(`${SITE}/t/${posts[0].id}`), env });
  assert(res.status === 200, `status ${res.status}`);
  const html = await res.text();
  const blocks = blocksOf(html);
  const nodes = nodesOf(blocks);
  assert(nodes.some(n => n["@type"] === "DiscussionForumPosting") && nodes.some(n => n["@type"] === "BreadcrumbList"), "missing DiscussionForumPosting or BreadcrumbList");
  pages.push({ file: `/t/${posts[0].id}`, canonical: (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1], html, blocks, nodes, kind: "take" });
});

/* ---------------- vocabulary (live from schema.org) ---------------- */

let VOCAB = null;
try {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  const r = await fetch("https://schema.org/version/latest/schemaorg-current-https.jsonld", { signal: ctl.signal });
  clearTimeout(t);
  const g = (await r.json())["@graph"];
  const id = x => (typeof x === "string" ? x : x && x["@id"] || "").replace(/^schema:/, "");
  const list = x => (x == null ? [] : Array.isArray(x) ? x : [x]).map(id);
  const classes = new Map(), props = new Map();
  for (const n of g) {
    const types = list(n["@type"]);
    if (types.includes("rdfs:Class")) classes.set(id(n["@id"]), { parents: list(n["rdfs:subClassOf"]) });
    if (types.includes("rdf:Property")) props.set(id(n["@id"]), { domains: list(n["schema:domainIncludes"]) });
  }
  const ancestors = (c, seen = new Set()) => { if (!classes.has(c) || seen.has(c)) return seen; seen.add(c); for (const p of classes.get(c).parents) ancestors(p, seen); return seen; };
  VOCAB = { classes, props, ancestors };
} catch (e) {
  console.warn(`WARN  schema.org vocabulary unreachable (${String(e.message).slice(0, 60)}) — type/property name check skipped this run`);
}

/* ---------------- generic checks on every page ---------------- */

const isAbs = u => typeof u === "string" && /^https:\/\/[^\s"']+$/.test(u);
const isSite = u => isAbs(u) && u.startsWith(SITE + "/");
const isDate = d => typeof d === "string" && !Number.isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 60_000;
const refsOnly = v => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "@id" in v;
const byId = nodes => new Map(nodes.filter(n => n["@id"]).map(n => [n["@id"], n]));
const resolve = (v, map) => (refsOnly(v) ? map.get(v["@id"]) : v);

await test("Every JSON-LD block is well-formed: schema.org context, typed nodes, no empty or null values", async () => {
  for (const p of pages) {
    for (const b of p.blocks) assert(b["@context"] === "https://schema.org", `${p.file}: @context must be https://schema.org`);
    const walk = (v, path) => {
      if (v === null || v === undefined || v === "") throw new Error(`${p.file}: empty value at ${path}`);
      if (Array.isArray(v)) { assert(v.length, `${p.file}: empty array at ${path}`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
      else if (typeof v === "object") {
        assert(v["@type"] || v["@id"], `${p.file}: node without @type at ${path}`);
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    p.nodes.forEach((n, i) => walk(n, `graph[${i}]`));
  }
});

await test("Every {\"@id\"} reference resolves to a node on the same page (author, publisher, breadcrumb, mainEntity, isPartOf)", async () => {
  for (const p of pages) {
    const map = byId(p.nodes);
    const walk = (v, path) => {
      if (refsOnly(v)) assert(map.has(v["@id"]), `${p.file}: ${path} points at ${v["@id"]}, which is not defined on this page`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "@id") walk(x, `${path}.${k}`);
    };
    p.nodes.forEach((n, i) => walk(n, `${n["@type"] || "node"}#${i}`));
  }
});

await test("Every @type is a schema.org class and every property is allowed on that type (live vocabulary)", async () => {
  if (!VOCAB) { console.warn("      (skipped: vocabulary unreachable)"); return; }
  const seen = new Set();
  for (const p of pages) {
    const walk = n => {
      if (!n || typeof n !== "object" || Array.isArray(n)) return;
      const t = n["@type"];
      if (t) {
        assert(VOCAB.classes.has(t), `${p.file}: unknown type ${t}`);
        const anc = VOCAB.ancestors(t);
        for (const k of Object.keys(n)) {
          if (k.startsWith("@")) continue;
          const pr = VOCAB.props.get(k);
          assert(pr, `${p.file}: ${t}.${k} is not a schema.org property`);
          assert(pr.domains.some(d => anc.has(d)), `${p.file}: ${k} is not allowed on ${t} (allowed on ${pr.domains.join(", ")})`);
          seen.add(`${t}.${k}`);
        }
      }
      for (const v of Object.values(n)) (Array.isArray(v) ? v : [v]).forEach(walk);
    };
    p.nodes.forEach(walk);
  }
  assert(seen.size > 20, "too few type/property pairs checked — did the pages lose their JSON-LD?");
});

await test("URLs are absolute https, site URLs are on www, and the page's canonical matches its structured data", async () => {
  const urlKeys = new Set(["url", "item", "mainEntityOfPage", "logo", "image", "relatedLink", "isPartOf"]);
  for (const p of pages) {
    const walk = (v, path, key) => {
      if (typeof v === "string" && urlKeys.has(key)) {
        assert(isAbs(v), `${p.file}: ${path} is not an absolute https URL: ${v}`);
        if (!/supabase\.co\//.test(v)) assert(isSite(v), `${p.file}: ${path} should be on ${SITE}: ${v}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
    };
    p.nodes.forEach((n, i) => walk(n, `${n["@type"]}#${i}`, null));
    const pageNode = p.nodes.find(n => /^(WebPage|CollectionPage|Article)$/.test(n["@type"]));
    if (pageNode && p.canonical) {
      const u = pageNode.url || pageNode.mainEntityOfPage;
      assert(u === p.canonical, `${p.file}: structured data URL ${u} differs from canonical ${p.canonical}`);
    }
  }
});

/* ---------------- Google rich-result requirements per type ---------------- */

const namedOrg = (v, map, where) => {
  const n = resolve(v, map);
  assert(n && n["@type"] === "Organization" && n.name && isAbs(n.url) && isAbs(n.logo), `${where}: must resolve to an Organization with name, url and logo`);
};

await test("BreadcrumbList and ItemList: sequential positions, names, URLs, counts", async () => {
  for (const p of pages) for (const n of p.nodes) {
    if (n["@type"] === "BreadcrumbList" || n["@type"] === "ItemList") {
      const items = n.itemListElement;
      assert(Array.isArray(items) && items.length, `${p.file}: ${n["@type"]} without items`);
      items.forEach((it, i) => {
        assert(it["@type"] === "ListItem" && it.position === i + 1, `${p.file}: ${n["@type"]} item ${i} position must be ${i + 1}`);
        assert(typeof it.name === "string" && it.name.trim(), `${p.file}: ${n["@type"]} item ${i} needs a name`);
        assert(isSite(it.item || it.url), `${p.file}: ${n["@type"]} item ${i} needs an absolute site URL (item or url)`);
      });
      if (n["@type"] === "ItemList") assert(n.numberOfItems === items.length, `${p.file}: numberOfItems ${n.numberOfItems} ≠ ${items.length}`);
      if (n["@type"] === "BreadcrumbList") assert(items[0].item === `${SITE}/`, `${p.file}: breadcrumb must start at the home page`);
    }
  }
});

await test("Article: headline ≤ 110 chars, image, ISO dates (published ≤ modified ≤ now), named author and publisher with logo", async () => {
  let n = 0;
  for (const p of pages) { const map = byId(p.nodes); for (const a of p.nodes.filter(x => x["@type"] === "Article")) {
    n++;
    assert(typeof a.headline === "string" && a.headline.length > 0 && a.headline.length <= 110, `${p.file}: headline missing or over 110 chars`);
    assert(Array.isArray(a.image) && a.image.every(isAbs), `${p.file}: Article.image must be a non-empty array of absolute URLs`);
    assert(isDate(a.datePublished) && isDate(a.dateModified), `${p.file}: dates must be ISO 8601 and not in the future`);
    assert(Date.parse(a.dateModified) >= Date.parse(a.datePublished), `${p.file}: dateModified before datePublished`);
    namedOrg(a.author, map, `${p.file}: Article.author`); namedOrg(a.publisher, map, `${p.file}: Article.publisher`);
    assert(isSite(a.mainEntityOfPage), `${p.file}: Article.mainEntityOfPage`);
  } }
  assert(n >= 50, `only ${n} Article nodes found`);
});

await test("City pages: CollectionPage with Place, breadcrumb; editors' intro as abstract by TripVibz; takes list as mainEntity", async () => {
  const intros = JSON.parse(await readFile("data/editorial/intros.json", "utf8"));
  let checked = 0;
  for (const p of pages.filter(x => x.kind === "city")) {
    const map = byId(p.nodes);
    const page = p.nodes.find(x => x["@type"] === "CollectionPage");
    assert(page, `${p.file}: no CollectionPage node`);
    assert(page.about && page.about["@type"] === "Place" && page.about.name, `${p.file}: CollectionPage.about must be a named Place`);
    assert(resolve(page.breadcrumb, map)?.["@type"] === "BreadcrumbList", `${p.file}: breadcrumb must resolve to the BreadcrumbList`);
    assert(resolve(page.isPartOf, map)?.["@type"] === "WebSite", `${p.file}: isPartOf must resolve to the WebSite`);
    namedOrg(page.publisher, map, `${p.file}: publisher`);
    assert(isDate(page.dateModified), `${p.file}: dateModified`);
    const slug = p.file.split("/")[1];
    const hasIntroBox = p.html.includes('id="tv-editors"');
    if (hasIntroBox) {
      assert(page.abstract === intros[slug], `${p.file}: abstract must equal the editors' intro shown on the page`);
      namedOrg(page.author, map, `${p.file}: intro author`);
    } else assert(!page.abstract, `${p.file}: abstract present but no intro on the page`);
    const list = p.nodes.find(x => x["@type"] === "ItemList");
    if (list) assert(resolve(page.mainEntity, map) === list, `${p.file}: mainEntity must point at the takes ItemList`);
    else assert(!page.mainEntity, `${p.file}: mainEntity without an ItemList`);
    if (page.relatedLink) assert(page.relatedLink.length >= 3 && page.relatedLink.every(isSite), `${p.file}: relatedLink should be the nearby city URLs`);
    checked++;
  }
  assert(checked >= 20, `only ${checked} city pages checked`);
});

await test("Home and /cities/: Organization (name, url, logo) + WebSite; cities index lists every city", async () => {
  const home = pages.find(p => p.kind === "home"), cities = pages.find(p => p.kind === "cities");
  assert(home && cities, "home or cities page missing structured data");
  for (const p of [home, cities]) {
    const org = p.nodes.find(n => n["@type"] === "Organization"), site = p.nodes.find(n => n["@type"] === "WebSite");
    assert(org && org.name && isSite(org.url) && isSite(org.logo), `${p.file}: Organization needs name, url, logo`);
    assert(!("sameAs" in org) || (Array.isArray(org.sameAs) && org.sameAs.length), `${p.file}: sameAs must be omitted or non-empty`);
    assert(site && site.name && isSite(site.url), `${p.file}: WebSite needs name and url`);
  }
  const list = cities.nodes.find(n => n["@type"] === "ItemList");
  let REMOVED = {}; try { REMOVED = JSON.parse(await readFile("data/removed-cities.json", "utf8")); } catch {}
  const dbCities = (await (await fetch(`${SB}/rest/v1/cities?select=slug`, { headers: { apikey: KEY } })).json()).filter(c => !REMOVED[c.slug]);
  assert(list && list.itemListElement.length === dbCities.length, `${cities.file}: ItemList has ${list && list.itemListElement.length} cities, database has ${dbCities.length}`);
});

await test("Take page: DiscussionForumPosting has author.name, datePublished, text, url; comments carry author/date/text", async () => {
  const p = pages.find(x => x.kind === "take");
  assert(p, "take page not rendered (see the first test)");
  const post = p.nodes.find(n => n["@type"] === "DiscussionForumPosting");
  assert(post.author && post.author["@type"] === "Person" && post.author.name, "author must be a named Person");
  assert(isDate(post.datePublished), "datePublished");
  assert(typeof post.text === "string" && post.text.trim(), "text");
  assert(isSite(post.url) && post.url === p.canonical, "url must equal the canonical");
  for (const c of post.comment || []) assert(c["@type"] === "Comment" && c.author?.name && isDate(c.datePublished) && c.text, "each Comment needs author, datePublished, text");
  for (const s of post.interactionStatistic || []) assert(s["@type"] === "InteractionCounter" && Number.isInteger(s.userInteractionCount), "interactionStatistic shape");
});

for (const r of results) console.log(r.join("  "));
const failed = results.filter(r => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
