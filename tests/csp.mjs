// Content-Security-Policy check: load every page type in a real browser with
// the policy from functions/_security.js ENFORCED and fail on any violation.
//
//   node build.mjs && node tests/csp.mjs                 (serves dist/ on :8091)
//   BASE=https://<branch>.tripvibz.pages.dev node tests/csp.mjs   (a preview; also
//        exercises GA4/Clarity/Stay22, which stay off on localhost)
//
// Why: the browser silently blocks anything the policy doesn't allow. A new
// script, font, iframe or API host added without updating the CSP would break
// the site for visitors while every other test stays green. This catches it.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { CSP } from "../functions/_security.js";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
  ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
async function serve() {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (/^\/t\/[0-9a-f-]{36}$/i.test(p)) p = "/thread.html";
    let f = join("dist", p);
    try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); }
    catch { if (!extname(f)) f += ".html"; }
    try { const b = await readFile(f); res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" }); res.end(b); }
    catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise(r => srv.listen(8091, r));
  return srv;
}

const server = process.env.BASE ? null : await serve();
const BASE = process.env.BASE || "http://localhost:8091";
const slug = JSON.parse(await readFile("data/editorial/intros.json", "utf8")) && "miami";
const PAGES = ["/", "/cities/", "/how-we-verify-locals/", `/${slug}/`, `/${slug}/worst-times-to-visit/`, `/${slug}/what-not-to-do/`, `/${slug}/what-locals-do/`,
  `/${slug}/add/`, `/${slug}/vote/`, "/t/00000000-0000-0000-0000-000000000000", "/admin.html", "/about/", "/privacy/", "/terms/", "/does-not-exist"];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
let failures = 0;
for (const path of PAGES) {
  const page = await ctx.newPage();
  const viol = new Set();
  page.on("console", m => { const t = m.text(); if (/Content Security Policy|Refused to/.test(t)) viol.add(t.slice(0, 200)); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", e =>
      console.error(`[CSP] ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile || ""}:${e.lineNumber || ""})`));
  });
  // Enforce the policy on the top-level document only (iframes keep their own).
  await page.route("**/*", async route => {
    const req = route.request();
    if (req.resourceType() !== "document" || req.frame() !== page.mainFrame()) return route.continue();
    const r = await route.fetch();
    return route.fulfill({ response: r, headers: { ...r.headers(), "content-security-policy": CSP } });
  });
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); } });
    await page.waitForTimeout(1500);
    const btn = page.locator("text=/sign in|local badge/i").first();
    if (await btn.count()) { try { await btn.click({ timeout: 2000 }); await page.waitForTimeout(1500); } catch {} }
  } catch (e) { viol.add("navigation: " + e.message.slice(0, 120)); }
  if (viol.size) failures++;
  console.log(`${viol.size ? "FAIL" : "PASS"}  ${path}`);
  for (const v of viol) console.log("        " + v);
  await page.close();
}
await browser.close();
if (server) server.close();
console.log(`\n${PAGES.length - failures}/${PAGES.length} pages load with the CSP enforced`);
process.exit(failures ? 1 : 0);
