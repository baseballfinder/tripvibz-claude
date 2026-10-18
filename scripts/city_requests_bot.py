#!/usr/bin/env python3
"""
City-request notifications and approvals (run by .github/workflows/city-requests.yml).

  notify  Any requested city that reached OPEN_AT asks gets a GitHub issue that
          @mentions James (GitHub emails him). Marks it notified so it fires once.
  open    James added the "approved" label to one of those issues: check the
          photo is uploaded, add the city with starter questions, build its
          share card. The workflow commits the card to main, which redeploys
          the site, then this closes the issue.

Env: SUPABASE_DB_URL, GH_TOKEN, GITHUB_REPOSITORY, and for `open` ISSUE_NUMBER.
"""
import json, os, re, subprocess, sys, urllib.request

import psycopg

OPEN_AT = 5
OWNER = "baseballfinder"
PHOTO_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co/storage/v1/object/public/city-photos/{}.webp"
REPO = os.environ.get("GITHUB_REPOSITORY", "baseballfinder/tripvibz-claude")


def gh(*args, input=None):
    return subprocess.run(["gh", *args, "--repo", REPO], input=input, text=True,
                          check=True, capture_output=True).stdout


def db():
    return psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True)


def notify():
    for label, color in (("city-request", "ff5630"), ("approved", "0e8a16")):
        subprocess.run(["gh", "label", "create", label, "--color", color, "--repo", REPO],
                       capture_output=True)
    with db() as conn:
        rows = conn.execute("""
            select c.slug, c.name, c.state, c.pop_rank, count(r.user_id) n
            from city_candidates c join city_requests r on r.city_slug = c.slug
            where c.notified_at is null
              and not exists (select 1 from cities x where x.slug = c.slug)
            group by c.slug, c.name, c.state, c.pop_rank
            having count(r.user_id) >= %s""", (OPEN_AT,)).fetchall()
        for slug, name, state, rank, n in rows:
            body = f"""<!-- slug:{slug} -->
@{OWNER} **{name}, {state}** just reached **{n} asks** on TripVibz (US rank #{rank} by population).

### To open it
1. **Upload a photo** to Supabase → Storage → `city-photos`, named exactly **`{slug}.webp`** (landscape, about 1600 px wide). Claude can resize one for you.
2. **Add the label `approved`** to this issue (right side → Labels).

That's it. The site then adds {name} with 5 starter questions, builds its Facebook share card and redeploys. This issue closes itself when it's live.

To skip this city, just close the issue.
"""
            gh("issue", "create", "--title", f"City request: {name}, {state} reached {n} asks",
               "--label", "city-request", "--body", body)
            conn.execute("update city_candidates set notified_at = now() where slug = %s", (slug,))
            print("notified", slug)
    if not rows:
        print("nothing new")


QUESTIONS = [
    ("Worst time to visit {c}?",
     [("holiday", "Holiday weeks"), ("summer", "Summer"), ("events", "Big-event weekends"), ("none", "No bad time")]),
    ("First trip to {c}: stay downtown, or somewhere else?",
     [("downtown", "Downtown"), ("hood", "A neighborhood"), ("outside", "Outside the city")]),
    ("Visiting {c} without a car: doable, or a mistake?",
     [("doable", "Doable"), ("mistake", "A mistake"), ("central", "Only if you stay central")]),
    ("{c}'s most famous attraction: worth it, or overrated?",
     [("worth", "Worth it"), ("over", "Overrated"), ("early", "Only if you go early")]),
    ("Is {c} worth a weekend trip?",
     [("yes", "Yes"), ("event", "Only for an event"), ("pass", "Pass through")]),
]


def photo_exists(slug):
    try:
        with urllib.request.urlopen(urllib.request.Request(PHOTO_URL.format(slug), method="HEAD"), timeout=20) as r:
            return r.status == 200
    except Exception:
        return False


def open_city():
    num = os.environ["ISSUE_NUMBER"]
    issue = json.loads(gh("issue", "view", num, "--json", "body,labels,state"))
    labels = {l["name"] for l in issue["labels"]}
    m = re.search(r"<!-- slug:([a-z0-9-]+) -->", issue["body"] or "")
    if "city-request" not in labels or not m:
        print("not a city request issue"); return
    slug = m.group(1)
    if not photo_exists(slug):
        gh("issue", "comment", num, "--body",
           f"@{OWNER} I couldn't find `{slug}.webp` in the `city-photos` bucket yet. "
           "Upload it, then add the `approved` label again.")
        gh("issue", "edit", num, "--remove-label", "approved")
        sys.exit(0)
    with db() as conn:
        c = conn.execute("select name, state, lat, lng from city_candidates where slug = %s", (slug,)).fetchone()
        if not c:
            print("unknown slug", slug); sys.exit(1)
        name, state, lat, lng = c
        city_id = conn.execute("select id from cities where slug = %s", (slug,)).fetchone()
        if not city_id:
            sort = conn.execute("select coalesce(max(sort), 0) + 1 from cities").fetchone()[0]
            city_id = conn.execute(
                "insert into cities (name, slug, state, lat, lng, sort) values (%s,%s,%s,%s,%s,%s) returning id",
                (name, slug, state, lat, lng, sort)).fetchone()
        city_id = city_id[0]
        if not conn.execute("select 1 from questions where city_id = %s", (city_id,)).fetchone():
            for i, (prompt, opts) in enumerate(QUESTIONS, 1):
                conn.execute(
                    "insert into questions (city_id, prompt, options, place_label, sort, active) values (%s,%s,%s,'Whole city',%s,true)",
                    (city_id, prompt.format(c=name), json.dumps([{"id": a, "label": b} for a, b in opts]), i))
        conn.execute("update city_candidates set opened_at = now() where slug = %s", (slug,))
    with open(os.environ.get("GITHUB_OUTPUT", "/dev/null"), "a") as f:
        f.write(f"slug={slug}\nname={name}\n")
    print("opened", slug)


if __name__ == "__main__":
    {"notify": notify, "open": open_city}[sys.argv[1]]()
