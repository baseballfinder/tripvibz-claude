/* TripVibz service worker — built into dist/sw.js by build.mjs, which fills in
   __BUILD__ (the deploy's commit) and __SHELL__ (the files to keep ready).

   Pages are network-first: every open fetches the live page and only falls
   back to a saved copy when the network fails, so a deploy reaches installed
   copies on their next open. Scripts, styles and fonts are cache-first (their
   URLs change when their content does). Photos are cache-first with a cap.
   Anything cross-origin (Supabase, analytics, Stay22) and /api/* is never
   touched: live data stays live. */
"use strict";
const BUILD = "__BUILD__";
const SHELL_CACHE = "tv-shell-" + BUILD;    // precached app shell, replaced every deploy
const PAGE_CACHE = "tv-pages-" + BUILD;     // pages visited, replaced every deploy
const MEDIA_CACHE = "tv-media";             // photos and icons, kept across deploys, capped
const MEDIA_LIMIT = 150;
const SHELL = __SHELL__;
const OFFLINE = "/offline/";
const PAGE_TIMEOUT_MS = 5000;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== PAGE_CACHE && k !== MEDIA_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Supabase, GA4, Clarity, Stay22: straight to the network
  if (url.pathname.startsWith("/api/")) return;        // live endpoints, never cached
  if (req.mode === "navigate") { e.respondWith(pageFirst(req)); return; }
  if (url.pathname === "/site.webmanifest" || /^\/assets\/(fonts\/|[^/]+\.(js|css)$)/.test(url.pathname)) { e.respondWith(cacheFirst(req, SHELL_CACHE)); return; }
  if (/\.(webp|png|jpg|jpeg|svg|ico)$/.test(url.pathname)) { e.respondWith(cacheFirst(req, MEDIA_CACHE, MEDIA_LIMIT)); return; }
});

// Live page first; a saved copy if the network is down or slow; the offline page last.
async function pageFirst(req) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(timer);
    // Never save a redirected response: Chrome refuses to serve one for a
    // navigation from cache (and the redirect itself is the live answer).
    if (res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      caches.open(PAGE_CACHE).then(c => c.put(stripQuery(req), copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    clearTimeout(timer);
    const saved = await caches.match(stripQuery(req), { cacheName: PAGE_CACHE })
      || await caches.match(stripQuery(req), { cacheName: SHELL_CACHE });
    return saved || (await caches.match(OFFLINE, { cacheName: SHELL_CACHE })) || Response.error();
  }
}

async function cacheFirst(req, name, limit) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !res.redirected && (res.type === "basic" || res.type === "default")) {
    cache.put(req, res.clone()).then(() => limit && trim(cache, limit)).catch(() => {});
  }
  return res;
}

// Oldest entries go first (Cache keys come back in insertion order).
async function trim(cache, limit) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(k);
}

// /miami/?s=worst_times is the same page as /miami/ for the offline copy.
function stripQuery(req) {
  const u = new URL(req.url);
  if (!u.search) return req;
  u.search = "";
  return new Request(u.toString(), { mode: req.mode === "navigate" ? "same-origin" : req.mode, credentials: req.credentials });
}

// A page can ask the waiting worker to take over at once (not used yet; the
// nudge script lets a new build apply on the next open instead).
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
