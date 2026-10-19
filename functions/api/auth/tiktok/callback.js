import { SB, CALLBACK, SITE, safeNext, cookie, back, sha256hex } from "./_shared.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const next = safeNext(cookie(request, "tt_next"));
  const code = url.searchParams.get("code");
  if (!code) return back(next, "tiktok_cancelled");
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== cookie(request, "tt_state")) return back(next, "tiktok_failed");

  try {
    // 1. TikTok: code → access token → profile
    const tok = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
        code, grant_type: "authorization_code", redirect_uri: CALLBACK })
    }).then(r => r.json());
    if (!tok.access_token || !tok.open_id) throw new Error("token: " + JSON.stringify(tok).slice(0, 200));
    const info = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
      headers: { authorization: "Bearer " + tok.access_token }
    }).then(r => r.json());
    const user = (info && info.data && info.data.user) || {};

    // 2. Supabase: find or create the account, then a one-time sign-in token
    const email = `tt-${(await sha256hex("tiktok:" + tok.open_id)).slice(0, 32)}@tiktok.users.tripvibz.com`;
    const meta = { full_name: user.display_name || "TikTok user", avatar_url: user.avatar_url || null, provider: "tiktok" };
    const admin = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "content-type": "application/json" };
    // Creating fails harmlessly if the account already exists.
    await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: admin,
      body: JSON.stringify({ email, email_confirm: true, user_metadata: meta, app_metadata: { provider: "tiktok" } }) });
    const link = await fetch(`${SB}/auth/v1/admin/generate_link`, { method: "POST", headers: admin,
      body: JSON.stringify({ type: "magiclink", email }) }).then(r => r.json());
    const hashed = link.hashed_token || (link.properties && link.properties.hashed_token);
    if (!hashed) throw new Error("link: " + JSON.stringify(link).slice(0, 200));
    // Keep the name and photo current.
    const uid = link.id || (link.user && link.user.id);
    if (uid) await fetch(`${SB}/auth/v1/admin/users/${uid}`, { method: "PUT", headers: admin,
      body: JSON.stringify({ user_metadata: meta }) });

    // 3. Back to the page they came from; tv.js finishes sign-in from the hash.
    const dest = new URL(next, SITE);
    dest.hash = "tt=" + encodeURIComponent(hashed);
    const headers = new Headers({ location: dest.toString() });
    headers.append("set-cookie", "tt_state=; Path=/api/auth/tiktok; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    headers.append("set-cookie", "tt_next=; Path=/api/auth/tiktok; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    return new Response(null, { status: 302, headers });
  } catch (e) {
    console.error("tiktok sign-in", e && e.message);
    return back(next, "tiktok_failed");
  }
}
