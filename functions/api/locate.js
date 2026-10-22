/**
 * POST /api/locate — "signed in nearby" check. Called once a day by a signed-in
 * person's browser (assets/tv.js). No prompt and no browser location permission:
 * Cloudflare already attaches a rough location to every request.
 *
 * Records, per TripVibz city within 150 miles, only whether the person was within
 * 40 miles ("near"). Optionally also the city they're looking at, even when far,
 * so admins can see it next to their takes. No IP and no coordinates are stored.
 *
 * Advisory, never a gate: phone networks and VPNs put people in the wrong city.
 * Admins revoke local status for spam (admin.html), and a revoked row is never
 * re-marked near by a later check.
 */
import { adminHeaders } from "./_supabase.js";
const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
export const NEAR_MI = 40, REGION_MI = 150;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function miles(aLat, aLng, bLat, bLng) {
  const r = (d) => (d * Math.PI) / 180, R = 3958.8;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const band = (mi) => (mi <= NEAR_MI ? "near" : mi <= REGION_MI ? "region" : "far");

/** Work out near/far for one signed-in user and save it. Returns { cities: [{city_id, slug, near, band, mi}] } or null. */
export async function locate(env, request, userId, focusCityId) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude), lng = Number(cf.longitude);
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const svc = adminHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  const cities = await (await fetch(`${SUPABASE_URL}/rest/v1/cities?select=id,slug,name,lat,lng`, { headers: svc })).json();
  const found = (Array.isArray(cities) ? cities : [])
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .map((c) => { const mi = miles(lat, lng, c.lat, c.lng); return { city_id: c.id, slug: c.slug, name: c.name, mi: Math.round(mi), band: band(mi) }; })
    .filter((c) => c.band !== "far" || c.city_id === focusCityId);
  if (!found.length) return { cities: [] };

  // Don't touch revoked rows: an admin's call stands.
  const ids = found.map((c) => c.city_id).join(",");
  const prior = await (await fetch(
    `${SUPABASE_URL}/rest/v1/local_checks?select=city_id,revoked&user_id=eq.${userId}&city_id=in.(${ids})`, { headers: svc })).json();
  const revoked = new Set((Array.isArray(prior) ? prior : []).filter((r) => r.revoked).map((r) => r.city_id));
  const rows = found.filter((c) => !revoked.has(c.city_id)).map((c) => ({
    user_id: userId, city_id: c.city_id, near: c.band === "near", band: c.band, checked_at: new Date().toISOString()
  }));
  if (rows.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/local_checks?on_conflict=user_id,city_id`, {
      method: "POST",
      headers: { ...svc, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows)
    });
  }
  return { cities: found.map((c) => ({ ...c, near: c.band === "near" && !revoked.has(c.city_id), revoked: revoked.has(c.city_id) })) };
}

/** The signed-in (non-anonymous) user behind a bearer token, or null. */
export async function userFrom(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id && !u.is_anonymous ? u : null;
}

export async function onRequestPost({ request, env }) {
  const user = await userFrom(request);
  if (!user) return json({ error: "not_signed_in" }, 401);
  let body = {};
  try { body = await request.json(); } catch { /* optional body */ }
  const focus = typeof body.city_id === "string" && /^[0-9a-f-]{36}$/i.test(body.city_id) ? body.city_id : null;
  const out = await locate(env, request, user.id, focus);
  // Only near/not-near goes back to the browser; distances stay server-side.
  return json({ ok: true, near: out ? out.cities.filter((c) => c.near).map((c) => c.slug) : [] });
}
