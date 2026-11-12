// Serves dist/ the way Cloudflare Pages does (clean URLs, /t/<id> → the thread page).
// Shared by tests/regression.mjs; returns the server so the caller can close it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
  ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };

export async function serveDist(port, root = "dist") {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (/^\/t\/[0-9a-f-]{36}$/i.test(p)) p = "/thread.html";
    const f = join(root, p);
    // Try the path as a file, then as a folder's index page, then as a clean URL (/about → about.html).
    // Each is read directly (no check-then-read), so the answer is whatever the file held when it was read.
    const tries = [f, join(f, "index.html")].concat(extname(f) ? [] : [f + ".html"]);
    for (const t of tries) {
      try {
        const b = await readFile(t);
        res.writeHead(200, { "content-type": TYPES[extname(t)] || "application/octet-stream" });
        return res.end(b);
      } catch { /* not this one */ }
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise(r => srv.listen(port, r));
  return srv;
}
