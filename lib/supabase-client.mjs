/**
 * The Supabase client this site actually needs — bundled by build.mjs into
 * /assets/supabase.js as `window.supabase.createClient(url, key)`.
 *
 * The full @supabase/supabase-js bundle is 57 KB gzipped and carries Realtime,
 * Storage and Edge Functions clients the pages never call (tv.js, v2.js and
 * the page scripts use `from`, `rpc` and `auth.*` only). This builds the same
 * client from its two halves — @supabase/postgrest-js and @supabase/auth-js,
 * the pinned versions in package-lock.json — at half the size, and wires them
 * together the way SupabaseClient does: every REST request carries the apikey
 * and the signed-in user's token as the Bearer (or the key when nobody is
 * signed in), so Row Level Security sees the same identity it always has.
 *
 * Same defaults as supabase-js, so existing sessions keep working:
 * storage key `sb-<ref>-auth-token`, persisted session, auto refresh,
 * implicit flow, session detected from the URL after an OAuth redirect.
 */
import { PostgrestClient } from "@supabase/postgrest-js";
import { GoTrueClient } from "@supabase/auth-js";

export function createClient(supabaseUrl, supabaseKey, options = {}) {
  if (!supabaseUrl) throw new Error("supabaseUrl is required.");
  if (!supabaseKey) throw new Error("supabaseKey is required.");
  const base = new URL(supabaseUrl.endsWith("/") ? supabaseUrl : supabaseUrl + "/");
  const headers = Object.assign({ "X-Client-Info": "tripvibz-supabase-client" }, (options.global && options.global.headers) || {});
  const authOptions = Object.assign({
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    storageKey: `sb-${base.hostname.split(".")[0]}-auth-token`
  }, options.auth || {});

  const auth = new GoTrueClient(Object.assign({
    url: new URL("auth/v1", base).href,
    headers: Object.assign({ Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }, headers),
    fetch: options.global && options.global.fetch
  }, authOptions));

  // The signed-in user's token, or null when there is no session.
  async function sessionToken() {
    const { data } = await auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  }

  const baseFetch = (options.global && options.global.fetch) || ((...a) => fetch(...a));
  const fetchWithAuth = async (input, init) => {
    const token = await sessionToken();
    const h = new Headers(init && init.headers);
    if (!h.has("apikey")) h.set("apikey", supabaseKey);
    if (!h.has("Authorization")) h.set("Authorization", `Bearer ${token || supabaseKey}`);
    return baseFetch(input, Object.assign({}, init, { headers: h }));
  };

  const rest = new PostgrestClient(new URL("rest/v1", base).href, {
    headers,
    schema: (options.db && options.db.schema) || "public",
    fetch: fetchWithAuth
  });

  return {
    supabaseUrl, supabaseKey, auth, rest,
    from: relation => rest.from(relation),
    schema: name => rest.schema(name),
    rpc: (fn, args = {}, opts = {}) => rest.rpc(fn, args, opts)
  };
}
