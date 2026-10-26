#!/usr/bin/env python3
"""Copy new TripVibz email signups into the TripVibz Kit account.

Runs hourly from .github/workflows/kit-sync.yml.

  python3 scripts/kit_sync.py check   # confirm the Kit key works, list tag count
  python3 scripts/kit_sync.py sync    # add new signups to Kit, tag them by city

Env: KIT_API_KEY (Kit v4 API key), SUPABASE_DB_URL.
Logs only counts and city names, never email addresses.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.kit.com/v4"
BATCH = 200
MAX_ATTEMPTS = 5


def kit(method, path, body=None):
    key = os.environ.get("KIT_API_KEY", "").strip()
    if not key:
        sys.exit("KIT_API_KEY is not set")
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "X-Kit-Api-Key": key,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "tripvibz-kit-sync",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Kit {method} {path.split('?')[0]} -> {e.code}: {detail}") from None


def all_tags():
    tags, after = {}, None
    while True:
        q = "/tags?per_page=1000" + (f"&after={after}" if after else "")
        out = kit("GET", q)
        for t in out.get("tags", []):
            tags[t["name"]] = t["id"]
        page = out.get("pagination", {})
        if not page.get("has_next_page"):
            return tags
        after = page.get("end_cursor")


def tag_id(tags, name):
    if name not in tags:
        out = kit("POST", "/tags", {"name": name})
        tags[name] = out["tag"]["id"]
        print(f"created Kit tag: {name}")
    return tags[name]


def check():
    acct = kit("GET", "/account")
    name = (acct.get("account") or {}).get("name") or "?"
    print(f"Kit key works. Account: {name}. Tags: {len(all_tags())}.")


def sync():
    import psycopg

    tags = all_tags()
    done = failed = 0
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True) as db:
        rows = db.execute(
            """select s.id, s.email, s.source, c.name
                 from public.email_signups s
                 left join public.cities c on c.id = s.city_id
                where s.synced_at is null and s.attempts < %s
                order by s.created_at
                limit %s""",
            (MAX_ATTEMPTS, BATCH),
        ).fetchall()
        print(f"{len(rows)} new signup(s) to add")
        for sid, email, source, city in rows:
            try:
                kit("POST", "/subscribers", {"email_address": email, "state": "active"})
                names = ["TripVibz signup", f"Source: {source}"]
                if city:
                    names.append(f"City: {city}")
                for n in names:
                    kit("POST", f"/tags/{tag_id(tags, n)}/subscribers", {"email_address": email})
                db.execute(
                    "update public.email_signups set synced_at = now(), sync_error = null, attempts = attempts + 1 where id = %s",
                    (sid,),
                )
                done += 1
                print(f"added signup #{sid} ({city or 'no city'}, {source})")
            except Exception as e:  # keep going; retry next hour
                msg = str(e).replace(email, "<email>")[:500]
                db.execute(
                    "update public.email_signups set sync_error = %s, attempts = attempts + 1 where id = %s",
                    (msg, sid),
                )
                failed += 1
                print(f"signup #{sid} failed: {msg}")
    print(f"done: {done} added, {failed} failed")
    if failed and not done:
        sys.exit(1)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "sync"
    {"check": check, "sync": sync}[mode]()
