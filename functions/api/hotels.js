/**
 * GET /api/hotels?city=<slug>: well-rated hotels near a city, for the Guide tab.
 *
 * Asks the hotel booking partner (Stay22's accommodations API) for hotels near
 * the city's centre with a price for one night about three weeks out, and
 * returns a slim list: name, position, nightly price, guest rating, number of
 * reviews, stars and the partner's booking link (which carries the TripVibz
 * affiliate ID, tied to the API key). The page picks the five closest to the
 * places people recommend (assets/guide.js pickHotels).
 *
 * Rules this keeps:
 * - Off until the key exists: with no env.STAY22_API_KEY it answers 204 and
 *   calls nobody, so the Guide just shows what it showed before.
 * - The partner's terms: listings are never stored (no database write); the
 *   answer is cached at the edge for at most 60 minutes.
 * - The key stays on the server: sent in a header, never in an address, never
 *   in the response.
 * - Not an open door to the partner's API: the only input is a city slug; the
 *   position comes from our own cities table.
 * - Design for failure (docs/ARCHITECTURE.md): every outside call has a time
 *   limit; anything that goes wrong answers 204 (fail open, a nice-to-have).
 * - Only links to the partner are passed on.
 *
 * Nothing about the visitor is sent to the partner by this call.
 */
import { SUPABASE_URL, SUPABASE_KEY } from "../_config.js";

const API = "https://api.stay22.com/v2/accommodations";
const RADIUS_M = 8000;          // how far from the city centre to look
const MIN_RATING = 8;           // guest rating, out of 10
const MIN_REVIEWS = 200;
const PAGE = 40;                // the page picks 5 of these
const CACHE_S = 3600;           // the partner allows up to 60 minutes
const DB_MS = 4000, API_MS = 6000;

const OFF = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const bad = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function getJson(url, init, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const iso = d => d.toISOString().slice(0, 10);
/** One night, starting the first Friday at least three weeks from today. */
export function stayDates(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 21));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  const out = new Date(d); out.setUTCDate(out.getUTCDate() + 1);
  return { checkin: iso(d), checkout: iso(out), nights: 1 };
}

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null));
function partnerLink(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" && /(^|\.)stay22\.com$/.test(x.hostname) ? x.href : null; } catch { return null; }
}

/** The partner's listing -> the few fields the page shows. Drops anything unusable. */
export function slim(results, nights = 1) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== "object") continue;
    const c = (r.location && r.location.coordinates) || {};
    const lat = num(c.lat), lng = num(c.lng);
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
    const url = partnerLink(r.url);
    if (!name || !url || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const sup = r.suppliers && typeof r.suppliers === "object" ? Object.values(r.suppliers) : [];
    // Lowest price any supplier quotes for the stay; null means "unknown", never free.
    const totals = sup.map(s => s && s.price && num(s.price.total)).filter(v => v != null && v > 0);
    const rt = r.rating || r.averageRatings || {};
    const rating = num(rt.value), reviews = num(rt.count), stars = num(rt.hotelStars);
    if (rating == null || rating < MIN_RATING || reviews == null || reviews < MIN_REVIEWS) continue;
    out.push({
      id: String(r.id || "").slice(0, 40), name, lat, lng, url,
      price: totals.length ? Math.round(Math.min(...totals) / Math.max(1, nights)) : null,
      rating: Math.round(rating * 10) / 10, reviews: Math.round(reviews),
      stars: stars != null && stars > 0 && stars <= 5 ? stars : null,
      cancel: !!(r.policies && r.policies.freeCancellation)
    });
  }
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const key = env && env.STAY22_API_KEY;
  const slug = new URL(request.url).searchParams.get("city") || "";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) return bad(400, "city");
  if (!key) return OFF();

  const dates = stayDates();
  const cache = typeof caches !== "undefined" && caches.default;
  const cacheKey = new Request(`https://www.tripvibz.com/api/hotels?city=${slug}&d=${dates.checkin}`);
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }

  const rows = await getJson(`${SUPABASE_URL}/rest/v1/cities?slug=eq.${slug}&select=slug,lat,lng&limit=1`, { headers: { apikey: SUPABASE_KEY } }, DB_MS);
  if (!rows) return OFF();
  const city = rows[0];
  if (!city || num(city.lat) == null || num(city.lng) == null) return bad(404, "city");

  const q = new URLSearchParams({
    lat: String(city.lat), lng: String(city.lng), radius: String(RADIUS_M), type: "hotel",
    checkin: dates.checkin, checkout: dates.checkout, adults: "2", currency: "USD",
    minguestrating: String(MIN_RATING), minratingcount: String(MIN_REVIEWS), pageSize: String(PAGE),
    campaign: `tripvibz_guidehotels_${slug.replace(/-/g, "_")}`
  });
  const data = await getJson(`${API}?${q}`, { headers: { "X-API-KEY": key, accept: "application/json" } }, API_MS);
  if (!data || !Array.isArray(data.results)) return OFF();
  const nights = (data.meta && num(data.meta.nights)) || dates.nights;
  const hotels = slim(data.results, nights);
  if (!hotels.length) return OFF();

  const res = new Response(JSON.stringify({ city: slug, checkin: dates.checkin, checkout: dates.checkout, currency: "USD", hotels }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=900, s-maxage=${CACHE_S}` }
  });
  if (cache) { const put = cache.put(cacheKey, res.clone()); context.waitUntil ? context.waitUntil(put) : await put; }
  return res;
}
