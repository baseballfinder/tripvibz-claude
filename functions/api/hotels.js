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
 * - Only links to the partner are passed on, and every one carries the
 *   TripVibz affiliate ID whatever ID the key itself belongs to (TripVibz
 *   never books under another site's ID).
 * - Photos: ?city=<slug>&photo=<hotel id> passes one hotel's photo through this
 *   server (60-minute cache, images only, size-capped). The page never loads
 *   images from booking sites directly, so they don't see the visitor and the
 *   page's content rules stay as they are. Only hotels in the city's current
 *   list can be asked for, so this is not an open image relay.
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
const DB_MS = 4000, API_MS = 6000, IMG_MS = 5000;
const AID = "tripvibz";         // the only affiliate ID a TripVibz link may carry
const IMG_MAX = 1500000;        // bytes
const IMG_TYPES = /^image\/(jpeg|png|webp|avif)\b/i;

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
  try {
    const x = new URL(String(u));
    if (x.protocol !== "https:" || !/(^|\.)stay22\.com$/.test(x.hostname)) return null;
    x.searchParams.set("aid", AID);
    return x.href;
  } catch { return null; }
}
function httpsUrl(u) { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } }

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
    const id = String(r.id || "").slice(0, 40);
    const thumb = /^[A-Za-z0-9._-]+$/.test(id) ? httpsUrl(r.thumbnailUrl || (Array.isArray(r.images) && r.images[0])) : null;
    out.push({
      id, name, lat, lng, url, thumb,
      price: totals.length ? Math.round(Math.min(...totals) / Math.max(1, nights)) : null,
      rating: Math.round(rating * 10) / 10, reviews: Math.round(reviews),
      stars: stars != null && stars > 0 && stars <= 5 ? stars : null,
      cancel: !!(r.policies && r.policies.freeCancellation)
    });
  }
  return out;
}

/** The city's current list (with photo addresses, which never leave the server). null = nothing to show. */
async function cityHotels(context, slug) {
  const key = context.env.STAY22_API_KEY;
  const dates = stayDates();
  const cache = typeof caches !== "undefined" && caches.default;
  const cacheKey = new Request(`https://www.tripvibz.com/api/hotels-data?city=${slug}&d=${dates.checkin}`);
  if (cache) { const hit = await cache.match(cacheKey); if (hit) { try { return await hit.json(); } catch { /* fall through */ } } }

  const rows = await getJson(`${SUPABASE_URL}/rest/v1/cities?slug=eq.${slug}&select=slug,lat,lng&limit=1`, { headers: { apikey: SUPABASE_KEY } }, DB_MS);
  if (!rows) return null;
  const city = rows[0];
  if (!city || num(city.lat) == null || num(city.lng) == null) return { missing: true };

  const q = new URLSearchParams({
    lat: String(city.lat), lng: String(city.lng), radius: String(RADIUS_M), type: "hotel",
    checkin: dates.checkin, checkout: dates.checkout, adults: "2", currency: "USD",
    minguestrating: String(MIN_RATING), minratingcount: String(MIN_REVIEWS), pageSize: String(PAGE),
    campaign: `tripvibz_guidehotels_${slug.replace(/-/g, "_")}`
  });
  const data = await getJson(`${API}?${q}`, { headers: { "X-API-KEY": key, accept: "application/json" } }, API_MS);
  if (!data || !Array.isArray(data.results)) return null;
  const nights = (data.meta && num(data.meta.nights)) || dates.nights;
  const hotels = slim(data.results, nights);
  if (!hotels.length) return null;
  const out = { city: slug, checkin: dates.checkin, checkout: dates.checkout, currency: "USD", hotels };
  if (cache) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_S}` } }));
    context.waitUntil ? context.waitUntil(put) : await put;
  }
  return out;
}

async function photo(context, slug, id, list) {
  const none = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const h = list && Array.isArray(list.hotels) && list.hotels.find(x => x.id === id);
  if (!h || !h.thumb) return none();
  const cache = typeof caches !== "undefined" && caches.default;
  const cacheKey = new Request(`https://www.tripvibz.com/api/hotels-photo?city=${slug}&id=${encodeURIComponent(id)}`);
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), IMG_MS);
  try {
    const r = await fetch(h.thumb, { signal: ctl.signal, headers: { accept: "image/avif,image/webp,image/jpeg,image/png" } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !IMG_TYPES.test(type) || Number(r.headers.get("content-length") || 0) > IMG_MAX) return none();
    const bytes = await r.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > IMG_MAX) return none();
    const res = new Response(bytes, { status: 200, headers: {
      "content-type": type.split(";")[0], "cache-control": `public, max-age=${CACHE_S}, s-maxage=${CACHE_S}`,
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
    if (cache) { const put = cache.put(cacheKey, res.clone()); context.waitUntil ? context.waitUntil(put) : await put; }
    return res;
  } catch { return none(); } finally { clearTimeout(t); }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const slug = params.get("city") || "", photoId = params.get("photo");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) return bad(400, "city");
  if (photoId != null && !/^[A-Za-z0-9._-]{1,40}$/.test(photoId)) return bad(400, "photo");
  if (!(env && env.STAY22_API_KEY)) return OFF();

  const list = await cityHotels(context, slug);
  if (photoId != null) return photo(context, slug, photoId, list);
  if (!list) return OFF();
  if (list.missing) return bad(404, "city");

  // What the page gets: no photo addresses, just our own path for each hotel that has one.
  const hotels = list.hotels.map(({ thumb, ...h }) => (thumb ? { ...h, img: `/api/hotels?city=${slug}&photo=${encodeURIComponent(h.id)}` } : h));
  return new Response(JSON.stringify({ city: list.city, checkin: list.checkin, checkout: list.checkout, currency: list.currency, hotels }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=900, s-maxage=${CACHE_S}` }
  });
}
