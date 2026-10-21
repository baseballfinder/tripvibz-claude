import { CALLBACK, safeNext, back } from "./_shared.js";

export async function onRequestGet({ request, env }) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) return back(next, "tiktok_off");
  const state = crypto.randomUUID();
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  u.searchParams.set("scope", "user.info.basic");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CALLBACK);
  u.searchParams.set("state", state);
  const headers = new Headers({ location: u.toString() });
  const opts = "Path=/api/auth/tiktok; Max-Age=600; HttpOnly; Secure; SameSite=Lax";
  headers.append("set-cookie", `tt_state=${state}; ${opts}`);
  headers.append("set-cookie", `tt_next=${encodeURIComponent(next)}; ${opts}`);
  return new Response(null, { status: 302, headers });
}
