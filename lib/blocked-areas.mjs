// Areas TripVibz does not cover (data/blocked-areas.json). One rule, used by
// the build (a city inside an area is never published) and the tests; the
// database enforces the same numbers with a trigger (tv_block_area) and
// scripts/city_requests_bot.py reads the same file.
export function blockedArea(city, areas) {
  const state = String(city.state || "").toUpperCase(), lng = Number(city.lng);
  if (!Number.isFinite(lng)) return null;
  for (const a of areas || []) {
    if (a.state !== state) continue;
    if (a.lng_east_of != null && lng > a.lng_east_of) return a;
    if (a.lng_west_of != null && lng < a.lng_west_of) return a;
  }
  return null;
}
