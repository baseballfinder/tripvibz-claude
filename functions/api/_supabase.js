/**
 * Headers for server-side Supabase calls with the secret (service role) key.
 * New keys (sb_secret_...) must go on the apikey header ONLY: Supabase rejects
 * them in "Authorization: Bearer" with "Invalid JWT". Legacy service_role keys
 * (JWTs, retired by Supabase at the end of 2026) also accept Authorization.
 */
export function adminHeaders(key, extra = {}) {
  const h = { apikey: key, ...extra };
  if (key && !key.startsWith("sb_")) h.authorization = `Bearer ${key}`;
  return h;
}
