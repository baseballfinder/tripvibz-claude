#!/usr/bin/env python3
"""
Load places near every TripVibz city into public.places_catalog from Overture
Maps' open data:

  kind 'eat'   food and drink, for the top-3 restaurant picker (real names, no
               misspellings, with address, phone, website and coordinates);
  kind 'spot'  parks, beaches, landmarks, museums, stadiums, plazas and the
               well-known neighborhoods (Overture divisions that have a
               Wikidata entry), for "Where is this?" on the add page, so a
               take can be pinned on the city's Guide map.

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


def place_files(release, theme="places", kind="place"):
    prefix = f"release/{release}/theme={theme}/type={kind}/"
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


# --- Which city a place belongs to ---------------------------------------
# data/city-localities.json: islands and strictly defined cities ("only") keep
# just the address localities listed for them; "also" lets a city claim
# localities even when another city's centre is nearer. Everyone else takes
# whatever is nearest within the radius. Places outside the US never load.
LOCALITIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "city-localities.json")


def norm_locality(s):
    return re.sub(r"\s+", " ", re.sub(r"[.\u2019']", "", str(s or ""))).strip().lower()


def load_limits(path=LOCALITIES_FILE):
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raw = {}
    limits = {}
    for slug, rule in raw.items():
        if slug.startswith("_"):
            continue
        if not isinstance(rule, dict) or not (set(rule) <= {"only", "also"}):
            sys.exit(f"{path}: {slug} must be an object with \"only\" and/or \"also\" lists")
        limits[slug] = {k: {norm_locality(x) for x in rule.get(k, [])} for k in ("only", "also")}
    return limits


def assign_city(all_cities, limits, lat, lng, locality, country=None):
    """The one TripVibz city a place belongs to, or None.
    1. Not in the US (Overture address country): none.
    2. A city that lists this locality (only/also) and is within the radius: the nearest such city.
    3. Otherwise the nearest city within the radius that is not an "only" city."""
    if country and str(country).upper() not in ("US", "USA"):
        return None
    loc = norm_locality(locality)
    near = sorted(((haversine(c["lat"], c["lng"], lat, lng), c) for c in all_cities), key=lambda x: x[0])
    near = [(d, c) for d, c in near if d <= RADIUS_KM]
    if loc:
        for d, c in near:
            rule = limits.get(c["slug"])
            if rule and (loc in rule["only"] or loc in rule["also"]):
                return c
    for d, c in near:
        rule = limits.get(c["slug"])
        if rule and rule["only"]:
            continue
        return c
    return None


def fetch_city(con, files, city, all_cities, limits):
    """Places within RADIUS_KM of this city that belong to it (assign_city), so a
    place between two cities lands in exactly one catalogue."""
    xmin, xmax, ymin, ymax = bbox(city["lat"], city["lng"], RADIUS_KM)
    q = f"""
      select id, names.primary as name, taxonomy.primary as category, basic_category,
             addresses[1].freeform as address, addresses[1].locality as locality, addresses[1].postcode as postcode,
             addresses[1].country as country,
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
        (pid, name, category, basic, address, locality, postcode, country, lat, lng, phone, website, instagram, confidence, status) = r
        name = re.sub(r"\s+", " ", str(name)).strip()
        if len(name) < 2 or len(name) > 80:
            continue
        # Inside the circle (not just the box) and this is the city it belongs to.
        home = assign_city(all_cities, limits, lat, lng, locality, country)
        if not home or home["id"] != city["id"]:
            continue
        if instagram:
            m = re.search(r"instagram\.com/([A-Za-z0-9_.]+)", instagram)
            instagram = m.group(1) if m else None
        out.append((pid, city["id"], name, category or basic, address, locality, postcode, lat, lng,
                    phone, (website or "")[:300] or None, instagram, confidence, status, "eat"))
    return out


# Things to see or meet at: Overture basic categories for spots.
SPOT_BASIC = ("park", "beach", "museum", "marina", "stadium_arena", "performing_arts_venue", "theatre_venue", "music_venue",
              "amusement_park", "amusement_attraction", "garden", "public_plaza", "monument", "national_park", "nature_reserve",
              "zoo", "aquarium", "pier", "farmers_market", "market", "landmark_and_historical_building", "historic_site",
              "recreational_trail_or_path", "lake", "bridge", "street_art", "science_attraction",
              "tourist_attraction", "attraction", "scenic_point", "lookout", "botanical_garden", "waterfront", "boardwalk")
SPOT_MIN_CONFIDENCE = 0.8
# "historic_site" in Overture also covers apartment blocks and offices; these names are never a spot.
SPOT_NOISE_RE = re.compile(r"\b(apartments?|apts|condos?|condominiums?|residences?|lofts?|towers?|suites|homes|villas|estates|"
                           r"signs?|realty|llc|inc|office|offices|storage|parking|garage|self storage|clinic|dental)\b", re.I)
NEIGHBORHOOD_SUBTYPES = ("neighborhood", "macrohood", "microhood")


def name_key(n):
    """Mirrors places_catalog.name_key / public.place_name_key."""
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"^\s*the\s+", "", str(n).lower())).strip()


def keep_one_per_name(rows):
    """Overture often lists one spot many times ("Fort Lauderdale Beach" x15, one of
    them miles inland). Keep the copy nearest the middle of its group, which beats
    keeping the highest confidence (the inland one scored highest) or the median."""
    groups = {}
    for r in rows:
        groups.setdefault(name_key(r[2]), []).append(r)
    out = []
    for g in groups.values():
        if len(g) == 1:
            out.append(g[0]); continue
        # The copy with the least total distance to the others (a medoid): outliers can't win.
        out.append(min(g, key=lambda r: sum(haversine(r[7], r[8], o[7], o[8]) for o in g)))
    return out


def in_city(city, all_cities, limits, lat, lng, locality=None, country=None):
    home = assign_city(all_cities, limits, lat, lng, locality, country)
    return bool(home) and home["id"] == city["id"]


def fetch_spots(con, files, div_files, city, all_cities, limits):
    """Spots for the Guide: sights from the places theme plus neighborhoods from divisions."""
    xmin, xmax, ymin, ymax = bbox(city["lat"], city["lng"], RADIUS_KM)
    rows = con.execute(f"""
      select id, names.primary as name, taxonomy.primary as category, basic_category,
             addresses[1].freeform as address, addresses[1].locality as locality, addresses[1].postcode as postcode,
             addresses[1].country as country,
             st_y(geometry) as lat, st_x(geometry) as lng, websites[1] as website, confidence, operating_status
        from read_parquet({json.dumps(files)})
       where bbox.xmin between {xmin} and {xmax} and bbox.ymin between {ymin} and {ymax}
         and names.primary is not null and basic_category in {SPOT_BASIC}
         and coalesce(confidence, 0) >= {SPOT_MIN_CONFIDENCE}
         and coalesce(operating_status, '') <> 'closed'
    """).fetchall()
    out = []
    for (pid, name, category, basic, address, locality, postcode, country, lat, lng, website, confidence, status) in rows:
        name = re.sub(r"\s+", " ", str(name)).strip()
        if len(name) < 3 or len(name) > 80 or SPOT_NOISE_RE.search(name) or not in_city(city, all_cities, limits, lat, lng, locality, country):
            continue
        if basic == "historic_site" and (confidence or 0) < 0.95:
            continue
        out.append((pid, city["id"], name, basic or category, address, locality, postcode, lat, lng,
                    None, (website or "")[:300] or None, None, confidence, status, "spot"))
    # Neighborhoods: only the ones notable enough to have a Wikidata entry (the rest are subdivisions).
    # DuckDB 1.4 trips over a wikidata filter pushed into the parquet scan, so it's applied here.
    divs = con.execute(f"""
      select id, names.primary, subtype, wikidata, st_y(st_centroid(geometry)), st_x(st_centroid(geometry))
        from read_parquet({json.dumps(div_files)})
       where bbox.xmin between {xmin} and {xmax} and bbox.ymin between {ymin} and {ymax}
         and subtype in {NEIGHBORHOOD_SUBTYPES} and names.primary is not null
    """).fetchall()
    seen_wd = set()
    for (did, name, subtype, wikidata, lat, lng) in divs:
        # A neighbourhood has no address; it goes by position alone (an "only" city gets none from here).
        if not wikidata or wikidata in seen_wd or lat is None or not in_city(city, all_cities, limits, lat, lng):
            continue
        seen_wd.add(wikidata)
        out.append((did, city["id"], str(name).strip()[:80], "neighborhood", None, None, None, lat, lng,
                    None, None, None, 1.0, None, "spot"))
    return keep_one_per_name(out)


def haversine(lat1, lng1, lat2, lng2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    import duckdb, psycopg
    dsn = os.environ.get("BOT_DB_URL") or os.environ.get("SUPABASE_DB_URL")
    if not dsn:
        sys.exit("BOT_DB_URL (or SUPABASE_DB_URL) is not set")
    only = sys.argv[1] if len(sys.argv) > 1 else None
    limits = load_limits()
    release = latest_release()
    files = place_files(release)
    div_files = place_files(release, "divisions", "division")
    print(f"Overture release {release}: {len(files)} place files, {len(div_files)} division files")

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
            eat = fetch_city(con, files, city, cities_all, limits)
            spots = fetch_spots(con, files, div_files, city, cities_all, limits)
            rows = eat + spots
            with pg.transaction(), pg.cursor() as cur:
                started = cur.execute("select now()").fetchone()[0]
                cur.executemany(
                    """insert into public.places_catalog
                         (id, city_id, name, category, address, locality, postcode, lat, lng, phone, website, instagram, confidence, status, kind, release, updated_at)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                       on conflict (id) do update set
                         city_id = excluded.city_id, name = excluded.name, category = excluded.category, address = excluded.address,
                         locality = excluded.locality, postcode = excluded.postcode, lat = excluded.lat, lng = excluded.lng,
                         phone = excluded.phone, website = excluded.website, instagram = excluded.instagram,
                         confidence = excluded.confidence, status = excluded.status, kind = excluded.kind, release = excluded.release, updated_at = now()""",
                    [r + (release,) for r in rows])
                # Anything this run did not write for the city leaves the picker: places that left the
                # release (closed, merged, removed) and places that now belong to another city or nowhere.
                cur.execute("delete from public.places_catalog where city_id = %s and (release <> %s or updated_at < %s)", (city["id"], release, started))
                gone = cur.rowcount
            total += len(rows)
            print(f"  {city['name']:<18} {len(eat):>6} places to eat  {len(spots):>5} spots  (-{gone} gone)  {time.time() - t:.1f}s")
        print(f"done: {total} places across {len(cities)} cities · Overture {release}")


if __name__ == "__main__":
    main()
