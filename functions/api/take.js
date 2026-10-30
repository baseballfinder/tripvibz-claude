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

// Input limits (mirrored by CHECK constraints in the database).
export const TITLE_MAX = 200, BODY_MAX = 2000;
export const TYPES = new Set(["what_not_to_do", "hidden_gem", "take", "worst_times"]);
const UUID = /^[0-9a-f-]{36}$/i;

import { notify, where, reportError } from "./_notify.js";
import { locate } from "./locate.js";

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

  const { title, body, type, city_id, place_id, city_name, place_label, months, topic, question_id } = payload || {};
  if (!title || !type || !city_id) {
    return json({ error: "missing_fields" }, 400);
  }
  // Shape and size checks before anything reaches the database. The page caps
  // a take at 400 characters (title ≤ 160); these ceilings are deliberately
  // above that so a UI change never trips them, and the database enforces the
  // same limits (migration 20261029_security_hardening) for anyone bypassing this.
  if (typeof title !== "string" || title.trim().length < 3 || title.length > TITLE_MAX) return json({ error: "bad_title" }, 400);
  if (body != null && (typeof body !== "string" || body.length > BODY_MAX)) return json({ error: "bad_body" }, 400);
  if (!TYPES.has(type)) return json({ error: "bad_type" }, 400);
  if (!UUID.test(String(city_id)) || (place_id != null && !UUID.test(String(place_id)))) return json({ error: "bad_id" }, 400);

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

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/posts`, {
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
      place_label: typeof place_label === "string" && place_label.trim() ? place_label.trim().slice(0, 60) : null,
      months: Array.isArray(months) && months.length ? months.filter(m => Number.isInteger(m) && m >= 1 && m <= 12) : null,
      ...(typeof topic === "string" && topic.trim() ? { topic: topic.trim().slice(0, 120) } : {}),
      ...(typeof question_id === "string" && /^[0-9a-f-]{36}$/i.test(question_id) ? { question_id } : {}),
      submitted_city,
      submitted_region,
      submitted_country,
      city_match
    })
  });
  } catch (e) {
    context.waitUntil(reportError(context.env, request, "/api/take", e));
    return json({ error: "upstream_unreachable" }, 502);
  }

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

  // Phone notification for James (functions/api/_notify.js); never delays the reply.
  const kind = { what_not_to_do: "Don't do this", hidden_gem: "Do this", take: "It depends", worst_times: "When to go" }[type] || type;
  const place = where(request);
  // Signed-in-nearby check for this take's city (advisory; see locate.js), then the alert.
  context.waitUntil((async () => {
    let geo = null;
    try {
      const out = row && row.author_id ? await locate(context.env, request, row.author_id, city_id) : null;
      geo = out && out.cities.find((c) => c.city_id === city_id);
    } catch { /* alert without it */ }
    const geoLine = !geo ? "" : geo.revoked ? "\nLocal status: revoked earlier"
      : geo.near ? "\n📍 Signed in nearby" : `\nNot nearby: about ${geo.mi} mi away`;
    await notify(context.env, {
    title: `New take: ${city_name || "TripVibz"}${topic ? " (new topic, needs review)" : ""}`,
    message: `${topic ? `Topic: ${topic}\n` : ""}${kind}: ${title}${place ? `\nPosted from near ${place}` : ""}${geoLine}`,
    click: row && row.id ? `https://www.tripvibz.com/t/${row.id}` : "https://www.tripvibz.com/",
    tags: topic ? "memo,warning" : "memo",
    priority: topic ? 4 : 3
    });
  })());

  return json({ ok: true, row, locality: { submitted_city, city_match } });
}
