/* ==========================================================================
   TripVibz build
   Copies the site into dist/ with JS and CSS minified — standalone assets
   plus the inline <script> and <style> blocks in each page.

   This is a size/performance step, NOT a security measure. Everything here
   still ships to the browser and can be read by anyone who cares to look.
   Keep secrets out of client code; the security boundary is Supabase RLS.
   ========================================================================== */

import { transform } from "esbuild";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const SRC = ".";
const OUT = "dist";
const SKIP = new Set(["dist", "node_modules", ".git", "supabase", ".github"]);

const bytes = n => (n / 1024).toFixed(1) + "kb";
const report = [];

/* ---- minify the inline blocks inside an HTML page ---- */

async function minifyHtml(html, label) {
  let out = html;

  // inline <script> without src
  const scripts = [...out.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const m of scripts) {
    const [full, attrs, code] = m;
    if (!code.trim()) continue;
    const res = await transform(code, { loader: "js", minify: true, target: "es2020" });
    out = out.replace(full, `<script${attrs}>${res.code.trim()}</script>`);
  }

  // inline <style>
  const styles = [...out.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)];
  for (const m of styles) {
    const [full, attrs, css] = m;
    if (!css.trim()) continue;
    const res = await transform(css, { loader: "css", minify: true });
    out = out.replace(full, `<style${attrs}>${res.code.trim()}</style>`);
  }

  // strip HTML comments (but keep conditional comments) and collapse blank lines
  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, "").replace(/\n{2,}/g, "\n");

  report.push([label, html.length, out.length]);
  return out;
}

async function walk(dir, rel = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;

    const from = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const to = join(OUT, relPath);

    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await walk(from, relPath);
      continue;
    }

    const ext = extname(entry.name).toLowerCase();
    const raw = await readFile(from);

    if (ext === ".html") {
      await writeFile(to, await minifyHtml(raw.toString("utf8"), relPath));
    } else if (ext === ".js" || ext === ".mjs") {
      const src = raw.toString("utf8");
      const res = await transform(src, { loader: "js", minify: true, target: "es2020" });
      await writeFile(to, res.code);
      report.push([relPath, src.length, res.code.length]);
    } else if (ext === ".css") {
      const src = raw.toString("utf8");
      const res = await transform(src, { loader: "css", minify: true });
      await writeFile(to, res.code);
      report.push([relPath, src.length, res.code.length]);
    } else {
      await writeFile(to, raw);
    }
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
// build.mjs itself must not ship
SKIP.add("build.mjs");
SKIP.add("package.json");
SKIP.add("package-lock.json");
await walk(SRC);

let before = 0, after = 0;
console.log("\n  file                     before     after    saved");
console.log("  " + "-".repeat(52));
for (const [name, b, a] of report.sort((x, y) => y[1] - x[1])) {
  before += b; after += a;
  const pct = b ? Math.round((1 - a / b) * 100) : 0;
  console.log(`  ${name.padEnd(24)} ${bytes(b).padStart(8)} ${bytes(a).padStart(9)}  ${String(pct).padStart(4)}%`);
}
console.log("  " + "-".repeat(52));
console.log(`  ${"total".padEnd(24)} ${bytes(before).padStart(8)} ${bytes(after).padStart(9)}  ${String(Math.round((1 - after / before) * 100)).padStart(4)}%\n`);
