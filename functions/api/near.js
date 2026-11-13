/**
 * GET /api/near: the visitor's rough position, so the Cities page can offer
 * "Near you: Nashville" without asking for location permission.
 *
 * Cloudflare already attaches a rough location to every request (the city
 * the visitor's internet provider routes through). This returns it rounded
 * to 0.1° (about 7 miles), to this visitor only. Nothing is stored or logged,
 * no database call, and nothing is sent anywhere else; the page works out
 * which TripVibz cities are close (assets/search.js nearest()).
 *
 * 204 when there is no usable location (local development, some networks).
 * Never cached, since the answer is per visitor.
 */
const HEADERS = { "content-type": "application/json", "cache-control": "no-store, private", "vary": "*" };

export function roughPosition(cf) {
  const lat = Number(cf && cf.latitude), lng = Number(cf && cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 };
}

export async function onRequestGet({ request }) {
  const pos = roughPosition(request.cf);
  if (!pos) return new Response(null, { status: 204, headers: { "cache-control": "no-store, private" } });
  return new Response(JSON.stringify(pos), { status: 200, headers: HEADERS });
}
