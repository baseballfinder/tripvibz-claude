/**
 * The database address and public key: the one place server code reads them
 * from (docs/ARCHITECTURE.md, "Config lives in one place"). The key is the
 * publishable one every browser already gets; the secret key lives only in
 * Cloudflare's settings (env.SUPABASE_SERVICE_ROLE_KEY).
 */
export const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
export const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
