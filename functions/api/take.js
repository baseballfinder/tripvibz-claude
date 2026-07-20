/**
 * POST /api/take — submit a contribution with a server-stamped locality signal.
 *
 * Why this exists: the client can claim any city. Cloudflare's request.cf is
 * attached by the edge and the browser cannot forge it, so the geo stamp has to
 * happen here rather than in page JS.
 *
 * What this is NOT: an authorisation check. It never rejects a submission for
 * being in the "wrong" city. A single reading proves "currently near", not
 * "lives here", and mobile carrier NAT gets city wrong often enough that
 * blocking on it would reject real locals. The stamp is advisory.
 *
 * Auth: we forward the caller's Supabase access token, so the insert runs as
 * that user and every RLS policy (non-anonymous identity, own author_id) and
 * the moderation trigger still apply exactly as they do from the browser.
 * This endpoint adds a field; it does not grant privilege.
 *
 * Privacy: only coarse city/region/country are stored. No IP, no lat/long.
 */

const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

// "Miami Beach" vs "miami beach" vs "Miami-Beach" should all match.
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

export async function onRequestPost(context) {
  const { request } = context;

  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return json({ error: "not_signed_in" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const { title, body, type, city_id, place_id, city_name } = payload || {};
  if (!title || !type || !city_id) {
    return json({ error: "missing_fields" }, 400);
  }

  // Geo comes from the edge. Absent when running locally or behind some
  // proxies — in that case we record nothing rather than guessing.
  const cf = request.cf || {};
  const submitted_city = cf.city || null;
  const submitted_region = cf.region || null;
  const submitted_country = cf.country || null;

  let city_match = null;
  if (submitted_city && city_name) {
    city_match = norm(submitted_city) === norm(city_name);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: auth,
      "content-type": "application/json",
      prefer: "return=representation"
    },
    body: JSON.stringify({
      title,
      body: body || null,
      type,
      city_id,
      place_id: place_id || null,
      submitted_city,
      submitted_region,
      submitted_country,
      city_match
    })
  });

  const text = await res.text();
  if (!res.ok) {
    // Pass the database message straight through so the client can still
    // translate MODERATION_BLOCKED_* into human copy.
    return json({ error: "insert_failed", detail: text }, res.status);
  }

  let row = null;
  try {
    row = JSON.parse(text)[0];
  } catch {
    /* representation not returned; the insert still succeeded */
  }

  return json({ ok: true, row, locality: { submitted_city, city_match } });
}
