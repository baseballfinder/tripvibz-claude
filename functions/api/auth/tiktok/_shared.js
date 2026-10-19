/**
 * Sign in with TikTok.
 *
 * Supabase has no built-in TikTok provider, and TikTok's login isn't standard
 * enough for Supabase's "custom provider" (it calls the client id client_key
 * and nests the profile), so this bridge does the TikTok part itself:
 *
 *   /api/auth/tiktok/start     → TikTok's consent screen
 *   /api/auth/tiktok/callback  → swap the code for the person's TikTok id,
 *      name and photo; find or create their TripVibz account (Supabase admin
 *      API); hand the browser a one-time sign-in token in the URL hash, which
 *      assets/tv.js exchanges for a normal session (verifyOtp).
 *
 * TikTok gives no email address, so the account gets a placeholder address
 * that is never mailed: tt-<hash of TikTok id>@tiktok.users.tripvibz.com.
 *
 * Cloudflare Pages env (Settings → Variables and Secrets):
 *   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET   from developers.tiktok.com (Login Kit, Web)
 *   SUPABASE_SERVICE_ROLE_KEY                 Supabase → Project Settings → API keys (secret)
 * Without them /start sends people back with ?signin=tiktok_off.
 */
export const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
export const SITE = "https://www.tripvibz.com";
export const CALLBACK = `${SITE}/api/auth/tiktok/callback`;

export function safeNext(n) {
  return typeof n === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : "/";
}
export function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
export function back(next, flag) {
  const u = new URL(safeNext(next), SITE);
  if (flag) u.searchParams.set("signin", flag);
  return Response.redirect(u.toString(), 302);
}
export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
