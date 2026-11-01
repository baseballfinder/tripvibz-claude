#!/usr/bin/env python3
"""
Search intent for every TripVibz question: what do people who search a
question's topic actually want, and which page template + data collection
fits it.

  python3 scripts/questions/intent.py suggest   -> data/keywords/<today>/google_suggest.json
        Google autocomplete for each phrasing in spec.py (bare, "<phrase> ", "is <phrase>").
        Polite: ~3 requests per phrasing, 0.35 s apart.
  python3 scripts/questions/intent.py classify  -> data/keywords/question-intent.csv (+ .json)
        Needs: Bing related searches (Question keywords workflow, related_only=1),
        the Google file above, and data/keywords/question-scores.csv.

Intent groups are keyword rules over (a) Bing related searches that mention the
topic, weighted by searches, and (b) Google suggestions, weighted by rank.
Shares are estimates for comparing questions, not measurements.
"""
import csv, datetime as dt, glob, json, os, re, sys, time, urllib.parse, urllib.request, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "data", "keywords")
sys.path.insert(0, HERE)
import spec  # noqa: E402

CITY_WORDS = {
 "asheville":"asheville nc north carolina","austin":"austin tx texas","charleston":"charleston sc south carolina",
 "chicago":"chicago il illinois","daytona-beach":"daytona beach fl florida","denver":"denver co colorado",
 "fort-lauderdale":"fort lauderdale ft fl florida","fort-myers":"fort myers fl florida","honolulu":"hawaii oahu honolulu hi",
"key-west":"key west fl florida keys","knoxville":"knoxville tn tennessee",
 "las-vegas":"las vegas nv nevada","miami":"miami fl florida","miami-beach":"miami beach fl florida","naples":"naples fl florida",
 "nashville":"nashville tn tennessee","new-orleans":"new orleans nola la louisiana","new-york":"new york nyc ny city manhattan",
 "orlando":"orlando fl florida","san-diego":"san diego ca california","san-francisco":"san francisco sf ca california",
 "sarasota":"sarasota fl florida","savannah":"savannah ga georgia","seattle":"seattle wa washington",
 "st-augustine":"st augustine saint fl florida","washington-dc":"washington dc d.c."}

MONTHS = r"january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec"
INTENTS = [  # (key, label, regex) — a query can match several
 ("when",     "When to go",        r"\bbest time\b|\bwhen (is|to|does|do)\b|\bweather\b|\btemperature|\bseason\b|\b(" + MONTHS + r")\b|\bwinter\b|\bsummer\b|\bspring\b|\bfall\b|\bautumn\b|\bcrowd|\bbusy\b|\bdates?\b|\bschedule\b|\bcalendar\b|\bhurricane|\brain(y)?\b|\bhumid"),
 ("tickets",  "Tickets & prices",  r"\btickets?\b|\bprices?\b|\bcost\b|\bcosts\b|\badmission\b|\bdeals?\b|\bdiscount|\bcoupon|\bgroupon|\bcostco\b|\bpass(es)?\b|\breservations?\b|\btours?\b|\bfree\b|\bexpensive\b|\bcheap|\bresort fees?\b|\bmilitary\b|\bseniors?\b|\brefundable\b|\bfare\b"),
 ("stay",     "Where to stay",     r"\bhotels?\b|\bresorts?\b|\bwhere to stay\b|\bstay(ing)?\b|\blodging\b|\bairbnb|\bvrbo\b|\brentals?\b|\bcabins?\b|\binn\b|\bmotels?\b|\bcondos?\b|\baccommodation"),
 ("logistics","Getting there & how-to", r"\bhours?\b|\bopen\b|\bclosed\b|\bparking\b|\bpark(ing)? (lot|garage)\b|\bdirections\b|\baddress\b|\blocation\b|\bhow to get\b|\bdrive\b|\bdriving\b|\bdistance\b|\bshuttle\b|\bferry\b|\btrain\b|\bbus\b|\buber\b|\blyft\b|\bairport\b|\bentrance\b|\bdog friendly\b|\bdogs?\b|\bwheelchair\b|\bwhat to wear\b|\bhow long\b|\btips\b|\brules\b|\bcashless\b|\bphone number\b|\bwait times?\b|\bmap\b|\bto (?!do\b|eat\b|stay\b|visit\b|go\b)\w+|\bfrom\b|\bwithout a car\b|\bcar\b|\btransit\b|\bwalk(ing|able)?\b|\bpermits?\b|\bbag policy\b|\breserve\b"),
 ("judge",    "Is it worth it",    r"\bworth\b|\breviews?\b|\breddit\b|\boverrated\b|\btourist trap\b|\bgood\b|\bfun\b|\bhype\b|\bbetter\b|\bvs\.?\b|\bversus\b|\bor\b|\bbest\b(?! time)"),
 ("discover", "Where locals go",   r"\brestaurants?\b|\bbars?\b|\bfood\b|\beat\b|\bthings to do\b|\bwhat to do\b|\battractions?\b|\bshops?\b|\bstores?\b|\bshopping\b|\bnightlife\b|\bbeach(es)?\b|\bspots?\b|\bplaces\b|\bmenu\b|\bbrunch\b|\bcoffee\b|\blive music\b|\bclubs?\b|\bbreweries\b|\bbrewery\b|\bbbq\b|\bpizza\b|\bdrinks?\b|\bactivities\b|\bkids\b|\bfamily\b|\bhikes?\b|\bhiking\b|\btrails?\b|\bpools?\b|\bmuseums?\b|\bneighborhoods?\b|\barea\b"),
 ("safety",   "Is it safe",        r"\bsafe\b|\bsafety\b|\bcrime\b|\bdangerous\b|\bsharks?\b|\bhomeless\b|\brip currents?\b|\bshooting\b|\bsketchy\b|\balone\b"),
 ("event",    "Events",            r"\bfestival\b|\bparades?\b|\bevents?\b|\bfireworks\b|\blineup\b|\bconcerts?\b|\bshows?\b|\bnights\b|\bhalloween\b|\bchristmas\b|\blights\b|\bparty\b|\bparties\b|\bcelebration\b|\bnew year|\bfourth of july\b|\b4th of july\b|\bgame ?day\b|\bschedule\b|\b202[6-8]\b"),
 ("live",     "Right now",         r"\bwebcam\b|\bcam\b|\blive\b(?! music)|\btoday\b|\btonight\b|\bnow\b|\btraffic\b|\bradar\b|\bwait times?\b|\bopen today\b"),
 ("resident", "Living there",      r"\bapartments?\b|\bhomes?\b|\breal estate\b|\bfor sale\b|\bzip code\b|\bcost of living\b|\bliving in\b|\bmoving\b|\bjobs?\b|\bschools?\b|\bpopulation\b|\bcondos? for\b|\bmortgage\b|\bcounty\b"),
 ("learn",    "History & facts",   r"\bhistory\b|\bwhat is\b|\bwho\b|\bhaunted\b|\bghosts?\b|\bphotos?\b|\bpictures?\b|\bmeaning\b|\bfacts?\b|\barchitecture\b|\bbuilt\b|\bowner\b|\bwiki"),
]
COMP = [(k, l, re.compile(p)) for k, l, p in INTENTS]
LABEL = {k: l for k, l, _ in INTENTS}

GENERIC = {"downtown", "river street", "the beach", "beach", "old city", "market square", "water taxi", "ghost tours", "cable car", "cable cars"}
def norm(s): return re.sub(r"\s+", " ", s.lower().replace("’", "'")).strip()

def core_of(phrase, slug):
    cw = set(CITY_WORDS.get(slug, "").split())
    toks = [t for t in re.findall(r"[a-z0-9']+", phrase.lower())]
    core = [t for t in toks if t not in cw]
    return " ".join(core) if core else phrase.lower()

RENT = re.compile(r"\b(car|bike|bicycle|e-?bikes?|boat|scooter|golf cart|kayak|paddle ?board|jet ?ski|moped|segway)s? rentals?\b")
NOISE = re.compile(r"roadside assistance|credit union|login|portal")
def intents_of(q):
    ks = [k for k, _, rx in COMP if rx.search(q)]
    m = RENT.search(q)
    if m:  # renting a car/bike is getting around, not lodging
        ks = [k for k in ks if k != "stay"]
        ks.append("logistics" if m.group(1) == "car" else "tickets")
    return list(dict.fromkeys(ks))



def suggest():
    phrases = sorted({norm(s) for qs in spec.CITIES.values() for q in qs for s in q["searches"]})
    def get(q):
        u = "https://suggestqueries.google.com/complete/search?" + urllib.parse.urlencode({"client": "firefox", "hl": "en", "gl": "us", "q": q})
        for a in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=15) as r:
                    return json.loads(r.read().decode("utf-8", "replace"))[1]
            except Exception:
                time.sleep(2 + 3 * a)
        return None
    res = {}
    for p in phrases:
        res[p] = {"bare": get(p), "space": get(p + " "), "is": get("is " + p)}
        time.sleep(0.35)
    d = os.path.join(OUT, dt.date.today().isoformat()); os.makedirs(d, exist_ok=True)
    json.dump(res, open(os.path.join(d, "google_suggest.json"), "w"), indent=1)
    print(len(res), "phrasings ->", d)


def classify():
    # ---- load data
    rel = collections.defaultdict(dict)
    for f in sorted(glob.glob(os.path.join(OUT, "*", "*", "related_keywords.csv"))):
        for r in csv.DictReader(open(f)):
            rel[norm(r["seed"])][norm(r["related_query"])] = int(r["impressions"] or 0)
    G = {}
    for f in sorted(glob.glob(os.path.join(OUT, "*", "google_suggest.json"))): G.update(json.load(open(f)))
    scores = {(r["city"], r["question"]): r for r in csv.DictReader(open(os.path.join(OUT, "question-scores.csv")))}

    out = []
    for slug, qs in spec.CITIES.items():
        for pos, Q in enumerate(qs, 1):
            gw, bw = collections.Counter(), collections.Counter()      # intent weights from Google / Bing
            gq, bq, asks = [], [], []
            for s in Q["searches"]:
                sp = norm(s); core = core_of(sp, slug)
                # Google: three lists, weight by rank; skip the echo of the phrase itself
                for kind in ("space", "bare", "is"):
                    lst = [norm(x) for x in (G.get(sp, {}).get(kind) or [])]
                    for i, x in enumerate(lst):
                        if x == sp or NOISE.search(x): continue
                        w = (11 - i) / 10
                        gq.append((x, w))
                        if kind == "is" or re.match(r"^(is|are|can|do|does|how|when|where|what|why|should)\b", x): asks.append(x)
                # Bing: related searches that mention the topic, weighted by searches
                for x, imp in rel.get(sp, {}).items():
                    if x == sp or core not in x or NOISE.search(x): continue
                    # generic topics ("downtown", "beach") only count when the city is named too
                    if (len(core.split()) < 2 or core in GENERIC) and not any(w in x.split() for w in CITY_WORDS.get(slug, "").split()): continue
                    bq.append((x, imp))
            def profile(items):
                c, tot = collections.Counter(), 0.0
                for x, w in items:
                    ks = intents_of(x)
                    tot += w
                    if not ks: c["name"] += w; continue
                    for k in ks: c[k] += w / len(ks)
                return {k: v / tot for k, v in c.items()} if tot else {}
            pg, pb = profile(gq), profile(bq)
            nb = len(bq)
            if pb and nb >= 5:
                keys = set(pg) | set(pb)
                prof = {k: 0.6 * pg.get(k, 0) + 0.4 * pb.get(k, 0) for k in keys}
            else:
                prof = pg
            # rank intents (ignore 'name' = plain lookups of the place)
            ranked = sorted(((k, v) for k, v in prof.items() if k != "name"), key=lambda x: -x[1])
            sc = scores.get((slug, Q["prompt"]), {})
            # de-dup asks, keep order of appearance
            seen, ask_list = set(), []
            for a in asks:
                a2 = re.sub(r"\s+", " ", a)
                if a2 not in seen: seen.add(a2); ask_list.append(a2)
            top_b = [x for x, _ in sorted(bq, key=lambda t: -t[1])[:6]]
            top_g = []
            for x, _ in gq:
                if x not in top_g: top_g.append(x)
            out.append({"city": slug, "pos": pos, "question": Q["prompt"], "options": Q["options"],
                "top_search": sc.get("top search", ""), "searches_month": int(sc.get("Bing searches/month") or 0),
                "demand": sc.get("demand", ""), "ig_posts": int(sc.get("Instagram posts") or 0),
                "profile": {k: round(v, 3) for k, v in sorted(prof.items(), key=lambda x: -x[1])},
                "intents": [(k, round(v, 3)) for k, v in ranked[:4]],
                "name_share": round(prof.get("name", 0), 3),
                "asks": ask_list[:12], "google": top_g[:15], "bing_related": top_b, "bing_n": nb})
    LBL = {"when":"When to go","name":"Looking the place up","logistics":"Getting there & how-to","discover":"Where locals go",
           "tickets":"Tickets & prices","stay":"Where to stay","event":"Event dates & plans","judge":"Is it worth it",
           "live":"Right now (webcam, traffic, open today)","learn":"History & facts","safety":"Is it safe","resident":"Living there"}
    TPL = {"A":"When to go","B":"Where to stay","C":"Plan the visit","D":"Where locals go","E":"Event guide","F":"Quick verdict","G":"Reword: right-now searches"}
    CHECKS = [("Safe at night?", r"\bsafe\b|dangerous|crime"), ("Free, or what it costs", r"\bfree\b|how much|\bcost|price|expensive|toll"),
              ("Open when? (days, season)", r"\bopen\b|closed|hours|year round|24"), ("Good for kids / dogs?", r"\bdog|\bkid|family"),
              ("Need a car / how to get there", r"need a car|how far|distance|\bdrive\b|from .* to|get to|walkable|light rail|trolley|streetcar|monorail"),
              ("Cash only?", r"\bcash"), ("Best time of day", r"sunset|sunrise|night|morning|crowd|busy|wait")]
    def template(o):
        p = o["profile"]; g = lambda k: p.get(k, 0); q = o["question"].lower()
        if re.search(r"^best time|best time to visit", q): return "A"
        top = o["intents"][0][0] if o["intents"] else "name"
        if re.search(r"20(2[6-9])\b", q) or (g("event") >= .3 and top == "event"): return "E"
        if re.search(r"^stay in|where to stay|: stay |base yourself|worth staying", q): return "B"
        if g("when") >= .4: return "A"
        if g("stay") >= .4: return "B"
        if g("live") >= .3: return "G"
        if g("tickets") >= .25 or g("logistics") >= .3: return "C"
        if g("discover") >= .3: return "D"
        if " or " in q and (g("discover") + g("safety") + g("judge")) >= .2: return "D"
        if g("name") >= .4: return "F"
        return {"when":"A","tickets":"C","logistics":"C","discover":"D","event":"E","live":"G"}.get(top, "F")
    rows = []
    for o in out:
        t = template(o); p = o["profile"]
        txt = " | ".join(o["asks"] + o["google"])
        checks = [n for n, rx in CHECKS if re.search(rx, txt)][:4]
        mods = [LBL[k] for k, v in o["intents"] if v >= .12 and k not in ("name",)]
        bookable = p.get("tickets",0) + p.get("stay",0) + .5 * p.get("event",0)
        rows.append({**o, "template": t, "checks": checks, "modules": mods, "bookable": round(bookable,3),
                     "booking_searches": round(o["searches_month"] * bookable)})
    json.dump(rows, open(os.path.join(OUT, "question-intent.json"), "w"), indent=1)
    with open(os.path.join(OUT, "question-intent.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["city", "position", "question", "top search", "Bing searches/month", "demand", "page template",
                    "what searchers want (share)", "share just looking the place up", "searchers also ask", "quick checks to collect",
                    "booking share", "booking searches/month"])
        for r in rows:
            w.writerow([r["city"], r["pos"], r["question"], r["top_search"], r["searches_month"], r["demand"], TPL[r["template"]],
                        "; ".join(f"{LBL[k]} {round(v*100)}%" for k, v in r["intents"][:3]), f"{round(r['name_share']*100)}%",
                        " | ".join(r["asks"][:4]), " | ".join(r["checks"]), f"{round(r['bookable']*100)}%", r["booking_searches"]])
    agg = collections.Counter()
    for r in rows:
        for k, v in r["profile"].items(): agg[k] += v / len(rows)
    print("intent share across all questions:", {LBL[k]: f"{round(v*100)}%" for k, v in agg.most_common()})
    print("templates:", collections.Counter(TPL[r["template"]] for r in rows).most_common())
    print("->", os.path.join(OUT, "question-intent.csv"))


if __name__ == "__main__":
    {"suggest": suggest, "classify": classify}[sys.argv[1] if len(sys.argv) > 1 else "classify"]()
