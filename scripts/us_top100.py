#!/usr/bin/env python3
"""
The 100 largest US cities (Census 2024 estimates, per Wikipedia's
"List of United States cities by population"), with approximate centers.
Writes supabase/migrations/20261018_city_candidates_seed.sql.

    python3 scripts/us_top100.py
"""
import os, re

# rank, name, state, population, lat, lng
CITIES = [
 (1,"New York","NY",8584629,40.7128,-74.0060),(2,"Los Angeles","CA",3869089,34.0522,-118.2437),
 (3,"Chicago","IL",2731585,41.8781,-87.6298),(4,"Houston","TX",2397315,29.7604,-95.3698),
 (5,"Phoenix","AZ",1665481,33.4484,-112.0740),(6,"Philadelphia","PA",1574281,39.9526,-75.1652),
 (7,"San Antonio","TX",1548422,29.4241,-98.4936),(8,"San Diego","CA",1406106,32.7157,-117.1611),
 (9,"Dallas","TX",1329491,32.7767,-96.7970),(10,"Fort Worth","TX",1028117,32.7555,-97.3308),
 (11,"Jacksonville","FL",1017689,30.3322,-81.6557),(12,"Austin","TX",1002632,30.2672,-97.7431),
 (13,"San Jose","CA",989814,37.3382,-121.8863),(14,"Charlotte","NC",964784,35.2271,-80.8431),
 (15,"Columbus","OH",938396,39.9612,-82.9988),(16,"Indianapolis","IN",901116,39.7684,-86.1581),
 (17,"San Francisco","CA",826079,37.7749,-122.4194),(18,"Seattle","WA",784777,47.6062,-122.3321),
 (19,"Denver","CO",740613,39.7392,-104.9903),(20,"Nashville","TN",721074,36.1627,-86.7816),
 (21,"Oklahoma City","OK",719849,35.4676,-97.5164),(22,"Washington","DC",693645,38.9072,-77.0369),
 (23,"El Paso","TX",683012,31.7619,-106.4850),(24,"Las Vegas","NV",679817,36.1699,-115.1398),
 (25,"Boston","MA",672973,42.3601,-71.0589),(26,"Detroit","MI",649095,42.3314,-83.0458),
 (27,"Louisville","KY",641962,38.2527,-85.7585),(28,"Portland","OR",635109,45.5152,-122.6784),
 (29,"Memphis","TN",609647,35.1495,-90.0490),(30,"Baltimore","MD",569997,39.2904,-76.6122),
 (31,"Milwaukee","WI",562407,43.0389,-87.9065),(32,"Albuquerque","NM",556588,35.0844,-106.6504),
 (33,"Fresno","CA",555549,36.7378,-119.7871),(34,"Tucson","AZ",548371,32.2226,-110.9747),
 (35,"Sacramento","CA",536449,38.5816,-121.4944),(36,"Atlanta","GA",529110,33.7490,-84.3880),
 (37,"Kansas City","MO",521220,39.0997,-94.5786),(38,"Mesa","AZ",513656,33.4152,-111.8315),
 (39,"Raleigh","NC",506306,35.7796,-78.6382),(40,"Colorado Springs","CO",494743,38.8339,-104.8214),
 (41,"Miami","FL",489812,25.7617,-80.1918),(42,"Omaha","NE",488797,41.2565,-95.9345),
 (43,"Virginia Beach","VA",453737,36.8529,-75.9780),(44,"Long Beach","CA",450469,33.7701,-118.1937),
 (45,"Oakland","CA",440838,37.8044,-122.2712),(46,"Minneapolis","MN",430324,44.9778,-93.2650),
 (47,"Bakersfield","CA",422165,35.3733,-119.0187),(48,"Tulsa","OK",416209,36.1540,-95.9928),
 (49,"Tampa","FL",413554,27.9506,-82.4572),(50,"Aurora","CO",410053,39.7294,-104.8319),
 (51,"Arlington","TX",402134,32.7357,-97.1081),(52,"Wichita","KS",400987,37.6872,-97.3301),
 (53,"Cleveland","OH",363608,41.4993,-81.6944),(54,"New Orleans","LA",362154,29.9511,-90.0715),
 (55,"Henderson","NV",353289,36.0395,-114.9817),(56,"Honolulu","HI",341868,21.3069,-157.8583),
 (57,"Anaheim","CA",341008,33.8366,-117.9143),(58,"Orlando","FL",333888,28.5383,-81.3792),
 (59,"Lexington","KY",329751,38.0406,-84.5037),(60,"Stockton","CA",324597,37.9577,-121.2908),
 (61,"Newark","NJ",323808,40.7357,-74.1724),(62,"Riverside","CA",323057,33.9806,-117.3755),
 (63,"Irvine","CA",318764,33.6846,-117.8265),(64,"Corpus Christi","TX",317247,27.8006,-97.3964),
 (65,"Santa Ana","CA",315586,33.7455,-117.8677),(66,"Cincinnati","OH",314367,39.1031,-84.5120),
 (67,"Greensboro","NC",308667,36.0726,-79.7920),(68,"Pittsburgh","PA",307632,40.4406,-79.9959),
 (69,"St. Paul","MN",306684,44.9537,-93.0900),(70,"Durham","NC",305561,35.9940,-78.8986),
 (71,"Jersey City","NJ",302013,40.7178,-74.0431),(72,"Lincoln","NE",301522,40.8136,-96.7026),
 (73,"North Las Vegas","NV",296653,36.1989,-115.1175),(74,"Plano","TX",293028,33.0198,-96.6989),
 (75,"Gilbert","AZ",287285,33.3528,-111.7890),(76,"Anchorage","AK",287155,61.2181,-149.9003),
 (77,"Madison","WI",286233,43.0731,-89.4012),(78,"Reno","NV",283621,39.5296,-119.8138),
 (79,"Chandler","AZ",278748,33.3062,-111.8413),(80,"St. Louis","MO",278144,38.6270,-90.1994),
 (81,"Chula Vista","CA",275533,32.6401,-117.0842),(82,"Fort Wayne","IN",275203,41.0793,-85.1394),
 (83,"Buffalo","NY",274613,42.8864,-78.8784),(84,"Lubbock","TX",273071,33.5779,-101.8552),
 (85,"Laredo","TX",269515,27.5306,-99.4803),(86,"Port St. Lucie","FL",268062,27.2730,-80.3582),
 (87,"St. Petersburg","FL",264033,27.7676,-82.6403),(88,"Toledo","OH",263423,41.6528,-83.5379),
 (89,"Glendale","AZ",260572,33.5387,-112.1860),(90,"Winston-Salem","NC",257271,36.0999,-80.2442),
 (91,"Irving","TX",257076,32.8140,-96.9489),(92,"Chesapeake","VA",255332,36.7682,-76.2875),
 (93,"Garland","TX",249625,32.9126,-96.6389),(94,"Scottsdale","AZ",243006,33.4942,-111.9261),
 (95,"Boise","ID",238429,43.6150,-116.2023),(96,"Richmond","VA",237257,37.5407,-77.4360),
 (97,"Frisco","TX",236955,33.1507,-96.8236),(98,"Cape Coral","FL",236264,26.5629,-81.9495),
 (99,"McKinney","TX",236001,33.1972,-96.6398),(100,"Huntsville","AL",233627,34.7304,-86.5861),
]

# Slugs that already match a live TripVibz city.
SLUG_OVERRIDES = {"Washington": "washington-dc", "St. Paul": "st-paul", "St. Louis": "st-louis",
                  "St. Petersburg": "st-petersburg", "Port St. Lucie": "port-st-lucie"}


def slug(name):
    return SLUG_OVERRIDES.get(name) or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def q(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    rows = ",\n".join(f"({q(slug(n))},{q(n)},{q(st)},{lat},{lng},{pop},{r})" for r, n, st, pop, lat, lng in CITIES)
    sql = ("-- Seed: the 100 largest US cities (Census 2024 estimates). Generated by scripts/us_top100.py\n"
           "insert into public.city_candidates (slug,name,state,lat,lng,population,pop_rank) values\n"
           f"{rows}\non conflict (slug) do update set name=excluded.name, state=excluded.state, lat=excluded.lat,\n"
           "  lng=excluded.lng, population=excluded.population, pop_rank=excluded.pop_rank;\n")
    out = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261018_city_candidates_seed.sql")
    open(out, "w").write(sql)
    print(len(CITIES), "cities ->", out)


if __name__ == "__main__":
    main()
