#!/usr/bin/env python3
"""
Gift cards for locals (run by .github/workflows/rewards.yml). DRAFT until the
repo variable REWARDS_ON is "1": until then `notify` does nothing.

The deal: 50 cents per take, paid as one gift card once someone signed in with
Google has answered every active question for a city with a take.

  notify  Finds people who just finished a city, records the card
          (reward_claims, one per person per city) and opens a GitHub issue
          that @mentions James with the takes to check. No email addresses or
          names go in the issue.
  pay     James labels the issue "pay": the card is ordered from Tremendous
          and emailed to the person. Label "reject" to skip it.

Tremendous runs in its sandbox (testflight.tremendous.com, fake money) unless
the repo variable TREMENDOUS_LIVE is "1".

Env: SUPABASE_DB_URL, GH_TOKEN, GITHUB_REPOSITORY, REWARDS_ON, TREMENDOUS_API_KEY,
TREMENDOUS_LIVE, TREMENDOUS_CAMPAIGN_ID (preferred: sets the email and the card
choices in Tremendous) or TREMENDOUS_PRODUCTS (comma list of product ids),
optional TREMENDOUS_FUNDING_SOURCE_ID; for `pay`/`reject` ISSUE_NUMBER.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

import psycopg

OWNER = "baseballfinder"
REPO = os.environ.get("GITHUB_REPOSITORY", "baseballfinder/tripvibz-claude")
SITE = "https://www.tripvibz.com"
CENTS_PER_TAKE = 50


def gh(*args):
    return subprocess.run(["gh", *args, "--repo", REPO], text=True, check=True,
                          capture_output=True).stdout


def db():
    return psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True)


def notify():
    if os.environ.get("REWARDS_ON") != "1":
        print("gift cards are in draft (REWARDS_ON is not 1): nothing to do"); return
    for label, color in (("gift-card", "c4391b"), ("pay", "0e8a16"), ("reject", "b60205")):
        subprocess.run(["gh", "label", "create", label, "--color", color, "--repo", REPO], capture_output=True)
    with db() as conn:
        done = conn.execute("""
            with q as (select city_id, count(*) n from questions where active group by city_id),
                 mine as (
                   select p.author_id, p.city_id, count(distinct p.question_id) answered
                   from posts p join questions qq on qq.id = p.question_id and qq.active
                   where p.status = 'approved' and p.author_verified
                   group by p.author_id, p.city_id)
            select m.author_id, m.city_id, c.name, c.slug, q.n
            from mine m join q on q.city_id = m.city_id and m.answered >= q.n
            join cities c on c.id = m.city_id
            join auth.users u on u.id = m.author_id
            where u.email is not null and coalesce(u.is_anonymous, false) = false
              and not exists (select 1 from reward_claims r where r.user_id = m.author_id and r.city_id = m.city_id)
        """).fetchall()
        for uid, cid, city, slug, n in done:
            amount = n * CENTS_PER_TAKE
            takes = conn.execute("""
                select p.id, q.prompt, p.title from posts p join questions q on q.id = p.question_id
                where p.author_id = %s and p.city_id = %s and q.active and p.status = 'approved'
                order by q.sort""", (uid, cid)).fetchall()
            other = conn.execute("select count(*) from reward_claims where user_id = %s", (uid,)).fetchone()[0]
            lines = [f"@{OWNER} A local finished **{city}**: {n} questions, {n} takes. "
                     f"Gift card: **${amount / 100:.2f}**.", "",
                     "### Check the takes are real", ""]
            lines += [f"- **{prompt}** {title} ([open]({SITE}/t/{pid}))" for pid, prompt, title in takes]
            lines += ["", f"Cards this person already earned in other cities: {other}.", "",
                      "### Decide", "- Label **`pay`**: Tremendous emails them the card.",
                      "- Label **`reject`**: no card (e.g. junk or copy-paste takes).", "",
                      "_Their email stays in the database; it is never written here._"]
            url = gh("issue", "create", "--title", f"Gift card: ${amount / 100:.2f} for finishing {city}",
                     "--label", "gift-card", "--body", "\n".join(lines)).strip()
            num = int(url.rstrip("/").split("/")[-1])
            conn.execute("""insert into reward_claims (user_id, city_id, takes, amount_cents, issue_number)
                            values (%s, %s, %s, %s, %s) on conflict (user_id, city_id) do nothing""",
                         (uid, cid, n, amount, num))
            print("gift card issue", num, slug)
        if not done:
            print("nobody new finished a city")


def tremendous(method, path, body=None):
    base = ("https://www.tremendous.com" if os.environ.get("TREMENDOUS_LIVE") == "1"
            else "https://testflight.tremendous.com")
    req = urllib.request.Request(base + "/api/v2/" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + os.environ["TREMENDOUS_API_KEY"],
                                          "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Tremendous {e.code}: {e.read().decode(errors='replace')[:500]}")


def pay():
    num = int(os.environ["ISSUE_NUMBER"])
    live = os.environ.get("TREMENDOUS_LIVE") == "1"
    with db() as conn:
        row = conn.execute("""
            select r.id, r.amount_cents, r.status, u.email,
                   coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', 'TripVibz local'), c.name
            from reward_claims r join auth.users u on u.id = r.user_id join cities c on c.id = r.city_id
            where r.issue_number = %s""", (num,)).fetchone()
        if not row:
            print("no gift card for issue", num); return
        rid, cents, status, email, name, city = row
        if status != "ready":
            gh("issue", "comment", str(num), "--body", f"Already {status}; not sending again."); return
        funding = os.environ.get("TREMENDOUS_FUNDING_SOURCE_ID") or next(
            f["id"] for f in tremendous("GET", "funding_sources")["funding_sources"] if f.get("method") == "balance")
        reward = {"value": {"denomination": round(cents / 100, 2), "currency_code": "USD"},
                  "delivery": {"method": "EMAIL"},
                  "recipient": {"name": name, "email": email}}
        if os.environ.get("TREMENDOUS_CAMPAIGN_ID"):
            reward["campaign_id"] = os.environ["TREMENDOUS_CAMPAIGN_ID"]
        else:
            reward["products"] = [p.strip() for p in os.environ["TREMENDOUS_PRODUCTS"].split(",") if p.strip()]
        order = tremendous("POST", "orders", {"external_id": f"tripvibz-{rid}",
                                              "payment": {"funding_source_id": funding}, "reward": reward})
        oid = (order.get("order") or {}).get("id")
        conn.execute("update reward_claims set status = 'sent', sent_at = now(), tremendous_order_id = %s where id = %s",
                     (oid, rid))
    gh("issue", "comment", str(num), "--body",
       f"Sent ${cents / 100:.2f} for {city} via Tremendous{'' if live else ' SANDBOX (no real money)'}. Order {oid}.")
    gh("issue", "close", str(num))


def reject():
    num = int(os.environ["ISSUE_NUMBER"])
    with db() as conn:
        conn.execute("update reward_claims set status = 'rejected' where issue_number = %s and status = 'ready'", (num,))
    gh("issue", "comment", str(num), "--body", "No card sent.")
    gh("issue", "close", str(num))


if __name__ == "__main__":
    {"notify": notify, "pay": pay, "reject": reject}[sys.argv[1]]()
