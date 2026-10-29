/**
 * Security headers — the ONE place they are defined.
 *
 *   • build.mjs writes them into dist/_headers, which Cloudflare Pages applies
 *     to every static page and asset.
 *   • Pages Functions do NOT get _headers applied to their responses, so the
 *     functions that return HTML (functions/t/[id].js) add them with
 *     withSecurityHeaders() below.
 *
 * Content-Security-Policy: every origin the site actually loads from, nothing
 * else. Verified against every page type with tests/csp.mjs (local build) and
 * against the live site before this was enforced. When a new third party is
 * added (a script, a font, an iframe, an API), add its origin here — the
 * browser blocks anything not listed, and tests/csp.mjs will fail first.
 *
 * script-src still allows 'unsafe-inline' because the page templates carry
 * inline <script> blocks and a few inline on*= handlers. Phase 2 is hashing
 * those at build time and dropping 'unsafe-inline'; that is the one remaining
 * gap between this policy and a strict one.
 */
export const CSP = [
  "default-src 'self'",
  // Site scripts (incl. the self-hosted Supabase client) + GA4, Clarity, Google sign-in.
  // Fonts are self-hosted (build.mjs), so no font or style origin beyond Google sign-in.
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://*.clarity.ms https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "font-src 'self' data:",
  // City photos (Supabase storage), sign-in avatars (Google/TikTok CDNs), share images.
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://nkxorlktzbgwqnfwmuus.supabase.co wss://nkxorlktzbgwqnfwmuus.supabase.co"
    + " https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com"
    + " https://*.clarity.ms https://c.bing.com https://accounts.google.com",
  // Stay22 hotel map + Google sign-in button/One Tap.
  "frame-src https://www.stay22.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nobody may put TripVibz in an iframe (clickjacking).
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  // One year of HTTPS-only for www.tripvibz.com and its subdomains. No "preload"
  // on purpose: that is a near-permanent registration and needs a deliberate yes.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // The site never asks for these; say so, so an injected script cannot either.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  // Keeps window.opener away from other sites while still allowing the Google sign-in popup.
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
};

/** Copy of `res` with the security headers added (never overriding ones already set). */
export function withSecurityHeaders(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
