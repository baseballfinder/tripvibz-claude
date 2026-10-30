/**
 * POST /api/event — a visitor's "Worst times to visit" calendar entry.
 *
 * The row is inserted as the caller (their Supabase token is forwarded, so
 * every row-security rule applies and city_events_guard marks it pending), and
 * James gets a phone notification like he does for takes, so a suggestion
 * never sits unseen. admin.html lists pending entries for approval.
 */
import { notify, where } from "./_notify.js";

const SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
const SEVERITY = new Set(["avoid", "busy", "good"]);
const UUID = /^[0-9a-f-]{36}$/i;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "not_signed_in" }, 401);
  let p;
  try { p = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { city_id, city_name, name, blurb, severity, start_month, end_month, source } = p || {};
  if (!UUID.test(String(city_id))) return json({ error: "bad_id" }, 400);
  if (typeof name !== "string" || name.trim().length < 3 || name.length > 120) return json({ error: "bad_name" }, 400);
  if (blurb != null && (typeof blurb !== "string" || blurb.length > 400)) return json({ error: "bad_blurb" }, 400);
  if (!SEVERITY.has(severity)) return json({ error: "bad_severity" }, 400);
  const months = [start_month, end_month].map(Number);
  if (!months.every(m => Number.isInteger(m) && m >= 1 && m <= 12)) return json({ error: "bad_months" }, 400);
  if (source != null && (typeof source !== "string" || source.length > 500)) return json({ error: "bad_source" }, 400);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/city_events`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, authorization: auth, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({ city_id, name: name.trim(), blurb: blurb ? blurb.trim() : null, severity, start_month: months[0], end_month: months[1], source: source || null })
  });
  if (!res.ok) return json({ error: "insert_failed", detail: await res.text() }, res.status);

  const place = where(request);
  context.waitUntil(notify(env, {
    title: `Calendar suggestion: ${city_name || "a city"}`,
    message: `${severity}, months ${months[0]}–${months[1]}: ${name.trim()}${blurb ? `\n${blurb.trim().slice(0, 200)}` : ""}${place ? `\nFrom near ${place}` : ""}\nReview: https://www.tripvibz.com/admin.html`,
    click: "https://www.tripvibz.com/admin.html",
    tags: "calendar",
    priority: 3
  }));
  return json({ ok: true, status: "pending" });
}
