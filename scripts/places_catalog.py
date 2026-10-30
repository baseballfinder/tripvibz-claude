#!/usr/bin/env python3
"""
Load eat-and-drink places near every TripVibz city into public.places_catalog
from Overture Maps' open "places" data, so the top-3 picker can offer real
names (no misspellings) with address, phone, website and coordinates.

  Source   Overture Maps Foundation, theme=places (CDLA-Permissive 2.0 — storing
           and redistributing the data is allowed; keep the attribution).
           Public bucket, monthly releases:
           https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/<date>/theme=places/type=place/*.parquet
  How      DuckDB reads the parquet files over HTTPS with bbox predicate
           pushdown, one query per city (a ~25 km box around cities.lat/lng),
           keeping places whose Overture category is food or drink. Rows are
           upserted by Overture id; rows for a city that vanished from the
           release are deleted (closed/removed places disappear from the picker
           but restaurant rows already picked are untouched).
  Run by   .github/workflows/places-catalog.yml (monthly + on demand) with the
           bot role (BOT_DB_URL) — never from a laptop against production.

    python3 scripts/places_catalog.py            # all cities
    python3 scripts/places_catalog.py miami      # one city (slug)
    PLACES_RELEASE=2026-10-21.0 python3 ...      # pin a release (default: latest)
"""
import os, re, sys, math, json, time, urllib.request, urllib.parse


import duckdb
import psycopg

BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
RADIUS_KM = float(os.environ.get("PLACES_RADIUS_KM", "25"))
MIN_CONFIDENCE = float(os.environ.get("PLACES_MIN_CONFIDENCE", "0.5"))
# Overture "basic_category" values that are food or drink, plus a taxonomy safety net.
FOOD_BASIC = ("restaurant", "bar", "cafe", "coffee_shop", "bakery", "dessert_shop", "food_truck",
              "pub", "brewery", "food_and_drink", "eat_and_drink", "ice_cream_shop", "juice_bar", "winery", "distillery")
# Anchored on the underscores Overture uses between words, so "deli" never matches "delivery".
FOOD_TAXONOMY_RE = r"(^|_)(restaurant|cafe|coffee_shop|bakery|bar|pub|brewery|winery|distillery|dessert_shop|ice_cream_shop|juice_bar|food_truck|pizza|taqueria|sushi|steakhouse|diner|bistro|gastropub|tea_room|donut_shop|bagel_shop|deli|creperie|patisserie|cocktail_bar|wine_bar|food_court|food_stand)(_|$)"


def latest_release():
    pinned = os.environ.get("PLACES_RELEASE")
    if pinned:
        return pinned
    xml = urllib.request.urlopen(f"{BUCKET}/?list-type=2&prefix=release/&delimiter=/", timeout=60).read().decode()
    rels = sorted(re.findall(r"<Prefix>release/([^/<]+)/</Prefix>", xml))
    if not rels:
        sys.exit("no Overture releases found")
    return rels[-1]


def place_files(release):
    prefix = f"release/{release}/theme=places/type=place/"
    xml = urllib.request.urlopen(f"{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefix)}&max-keys=1000", timeout=60).read().decode()
    keys = re.findall(r"<Key>([^<]+)</Key>", xml)
    files = [f"{BUCKET}/{k}" for k in keys if k.endswith(".parquet") or "/part-" in k]
    if not files:
        sys.exit(f"no parquet files under {prefix}")
    return files


def bbox(lat, lng, km):
    dlat = km / 111.32
    dlng = km / (111.32 * max(0.2, math.cos(math.radians(lat))))
    return lng - dlng, lng + dlng, lat - dlat, lat + dlat


def fetch_city(con, files, city, all_cities):
    """Places within RADIUS_KM of this city — and nearer to it than to any other
    TripVibz city, so a place between two cities lands in exactly one catalogue."""
    xmin, xmax, ymin, ymax = bbox(city["lat"], city["lng"], RADIUS_KM)
    q = f"""
      select id, names.primary as name, taxonomy.primary as category, basic_category,
             addresses[1].freeform as address, addresses[1].locality as locality, addresses[1].postcode as postcode,
             st_y(geometry) as lat, st_x(geometry) as lng,
             phones[1] as phone, websites[1] as website,
             list_filter(coalesce(socials, []), lambda s: s like '%instagram.com%')[1] as instagram,
             confidence, operating_status as status
        from read_parquet({json.dumps(files)})
       where bbox.xmin between {xmin} and {xmax} and bbox.ymin between {ymin} and {ymax}
         and names.primary is not null
         and (basic_category in {FOOD_BASIC} or regexp_matches(coalesce(taxonomy.primary, ''), '{FOOD_TAXONOMY_RE}'))
         and coalesce(confidence, 0) >= {MIN_CONFIDENCE}
         and coalesce(operating_status, '') <> 'closed'
    """
    rows = con.execute(q).fetchall()
    out = []
    for r in rows:
        (pid, name, category, basic, address, locality, postcode, lat, lng, phone, website, instagram, confidence, status) = r
        name = re.sub(r"\s+", " ", str(name)).strip()
        if len(name) < 2 or len(name) > 80:
            continue
        # Keep it inside the circle, not just the box, and only if this is its nearest city.
        d = haversine(city["lat"], city["lng"], lat, lng)
        if d > RADIUS_KM:
            continue
        if any(haversine(o["lat"], o["lng"], lat, lng) < d for o in all_cities if o["id"] != city["id"]):
            continue
        if instagram:
            m = re.search(r"instagram\.com/([A-Za-z0-9_.]+)", instagram)
            instagram = m.group(1) if m else None
        out.append((pid, city["id"], name, category or basic, address, locality, postcode, lat, lng,
                    phone, (website or "")[:300] or None, instagram, confidence, status))
    return out


def haversine(lat1, lng1, lat2, lng2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    dsn = os.environ.get("BOT_DB_URL") or os.environ.get("SUPABASE_DB_URL")
    if not dsn:
        sys.exit("BOT_DB_URL (or SUPABASE_DB_URL) is not set")
    only = sys.argv[1] if len(sys.argv) > 1 else None
    release = latest_release()
    files = place_files(release)
    print(f"Overture release {release}: {len(files)} place files")

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")

    with psycopg.connect(dsn) as pg:
        rows = pg.execute("select id, slug, name, lat, lng from public.cities where lat is not null and lng is not null order by sort").fetchall()
        cities_all = [dict(id=str(c[0]), slug=c[1], name=c[2], lat=float(c[3]), lng=float(c[4])) for c in rows]
        cities = [c for c in cities_all if not only or c["slug"] == only]
        if not cities:
            sys.exit("no cities to load")
        total = 0
        for city in cities:
            t = time.time()
            rows = fetch_city(con, files, city, cities_all)
            with pg.transaction():
                pg.executemany(
                    """insert into public.places_catalog
                         (id, city_id, name, category, address, locality, postcode, lat, lng, phone, website, instagram, confidence, status, release, updated_at)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                       on conflict (id) do update set
                         city_id = excluded.city_id, name = excluded.name, category = excluded.category, address = excluded.address,
                         locality = excluded.locality, postcode = excluded.postcode, lat = excluded.lat, lng = excluded.lng,
                         phone = excluded.phone, website = excluded.website, instagram = excluded.instagram,
                         confidence = excluded.confidence, status = excluded.status, release = excluded.release, updated_at = now()""",
                    [r + (release,) for r in rows])
                # Places that left the release for this city (closed, merged, removed) leave the picker.
                gone = pg.execute("delete from public.places_catalog where city_id = %s and release <> %s", (city["id"], release)).rowcount
            total += len(rows)
            print(f"  {city['name']:<18} {len(rows):>6} places  (-{gone} gone)  {time.time() - t:.1f}s")
        print(f"done: {total} places across {len(cities)} cities · Overture {release}")


if __name__ == "__main__":
    main()
