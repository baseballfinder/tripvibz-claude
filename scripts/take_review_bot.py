#!/usr/bin/env python3
"""
Review queue for takes on NEW topics (run by .github/workflows/take-reviews.yml).

Answers to a city's questions post instantly. A take on a topic of the
person's own waits (status 'pending') until James approves it here:

  notify  Each new pending topic gets a Bing search check and a GitHub issue
          that @mentions James with the take, the search numbers and the
          Instagram hashtags to look at. One issue per take, once.
  decide  James labels the issue "approved" (take goes live) or "rejected"
          (stays hidden). Closing the issue without a label leaves it pending.

Instagram counts can't be read from GitHub's servers; the issue links the
hashtags, and Claude fills in the counts when it reviews the queue.

Env: SUPABASE_DB_URL, GH_TOKEN, GITHUB_REPOSITORY, BING_WM_API_KEY (optional:
without it the issue says search wasn't checked), and for `decide`
ISSUE_NUMBER + LABEL.
"""
import datetime as dt
import os
import re
import subprocess
import sys

import psycopg

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "keywords"))
import bing_keywords as bing  # noqa: E402

OWNER = "baseballfinder"
REPO = os.environ.get("GITHUB_REPOSITORY", "baseballfinder/tripvibz-claude")
SITE = "https://www.tripvibz.com"
MONTHS_OF_DATA = 5.6        # Bing keeps ~24 weeks; same convention as scripts/questions
KIND = {"what_not_to_do": "Don't do this", "hidden_gem": "Do this", "take": "It depends",
        "worst_times": "When to go"}


def gh(*args):
    return subprocess.run(["gh", *args, "--repo", REPO], text=True, check=True,
                          capture_output=True).stdout


def db():
    return psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True)


def tier(search):
    # Search-only version of scripts/questions/research.py tier().
    if search >= 500: return "Strong"
    if search >= 100: return "Moderate"
    if search > 0: return "Weak"
    return "Not searched"


def bing_monthly(phrases):
    """{phrase: searches/month} plus up to 5 related searches for the first phrase."""
    try:
        _, key, _ = bing.find_key()
    except RuntimeError:
        return None, []
    today = dt.date.today()
    end = today.replace(day=1) - dt.timedelta(days=1)
    start = (end.replace(day=1) - dt.timedelta(days=330)).replace(day=1)
    window = {"startDate": start.isoformat(), "endDate": end.isoformat()}
    out, related = {}, []
    for i, ph in enumerate(phrases):
        base = {"q": ph, "country": "us", "language": "en-US"}
        st, p = bing.call("GetKeyword", {**base, **window}, key)
        imp = 0
        if st == 200:
            for r in bing.rows_of(p):
                if isinstance(r, dict):
                    imp = max(imp, int(r.get("Impressions") or 0))
        out[ph] = round(imp / MONTHS_OF_DATA)
        if i == 0:
            st, p = bing.call("GetRelatedKeywords", {**base, **window}, key)
            if st == 200:
                rows = [r for r in bing.rows_of(p) if isinstance(r, dict) and r.get("Query")]
                rows.sort(key=lambda r: -int(r.get("Impressions") or 0))
                related = [(r["Query"], round(int(r.get("Impressions") or 0) / MONTHS_OF_DATA)) for r in rows[:5]]
    return out, related


def hashtags(topic, city):
    words = re.sub(r"[^a-z0-9 ]", "", topic.lower()).split()
    stop = {"the", "a", "an", "in", "at", "on", "of", "to", "and", "or", "for", "near", "is"}
    core = "".join(w for w in words if w not in stop)
    c = re.sub(r"[^a-z0-9]", "", city.lower())
    tags = [t for t in dict.fromkeys([core, c + core, core + c]) if 3 <= len(t) <= 40]
    return tags[:3]


def notify():
    for label, color in (("take-review", "fbca04"), ("approved", "0e8a16"), ("rejected", "b60205")):
        subprocess.run(["gh", "label", "create", label, "--color", color, "--repo", REPO], capture_output=True)
    with db() as conn:
        rows = conn.execute("""
            select p.id, p.topic, p.title, p.body, p.type, p.author_verified, c.name, c.slug
            from posts p join cities c on c.id = p.city_id
            where p.status = 'pending' and p.topic is not null
              and not exists (select 1 from take_reviews r where r.post_id = p.id)
            order by p.created_at limit 20""").fetchall()
        for pid, topic, title, body, kind, verified, city, slug in rows:
            phrases = list(dict.fromkeys([topic.lower(), f"{topic} {city}".lower()]))
            searches, related = bing_monthly(phrases)
            best = max(searches.values()) if searches else None
            best_phrase = max(searches, key=searches.get) if searches else None
            rating = tier(best) if best is not None else "Search not checked"
            tags = hashtags(topic, city)

            lines = [f"<!-- post:{pid} -->",
                     f"@{OWNER} New topic for **{city}** waiting for review.", "",
                     f"**Topic:** {topic}  ", f"**Kind:** {KIND.get(kind, kind)}  ",
                     f"**From:** {'signed-in local' if verified else 'anonymous'}", "",
                     "> " + (body or title).replace("\n", "\n> "), "",
                     "### Is anyone looking for this?",
                     f"**Search: {rating}**" + (f" · best phrase \"{best_phrase}\" ≈ {best:,} Bing searches/month" if best else ""), ""]
            if searches:
                lines += ["| Search phrase | Bing searches/month |", "|---|---|"]
                lines += [f"| {ph} | {n:,} |" for ph, n in searches.items()]
                lines += [f"| _related:_ {q} | {n:,} |" for q, n in related]
                lines += ["", "_Bing is ~12% of US desktop search: compare questions with it, don't treat it as total demand._"]
            lines += ["", "**Instagram hashtags to check:** " + " · ".join(
                f"[#{t}](https://www.instagram.com/explore/tags/{t}/)" for t in tags),
                "_(Counts can't be read from GitHub; Claude adds them when it reviews the queue.)_", "",
                "### Decide",
                "- Label **`approved`**: the take goes live on the city page.",
                "- Label **`rejected`**: it stays hidden.",
                f"- Leave it: stays waiting. The person sees it marked \"Waiting for review\" on {SITE}/{slug}/"]
            url = gh("issue", "create", "--title", f"Review: \"{topic}\" ({city}) · search {rating}",
                     "--label", "take-review", "--body", "\n".join(lines)).strip()
            num = int(url.rstrip("/").split("/")[-1])
            conn.execute("""insert into take_reviews (post_id, search_phrase, bing_monthly, hashtag, rating, issue_number)
                            values (%s, %s, %s, %s, %s, %s) on conflict (post_id) do nothing""",
                         (pid, best_phrase, best, tags[0] if tags else None, rating, num))
            print("review issue", num, topic)
        if not rows:
            print("nothing waiting")


def decide():
    num, label = int(os.environ["ISSUE_NUMBER"]), os.environ["LABEL"]
    status = {"approved": "approved", "rejected": "rejected"}.get(label)
    if not status:
        return
    with db() as conn:
        row = conn.execute("select post_id from take_reviews where issue_number = %s", (num,)).fetchone()
        if not row:
            print("no take for issue", num); return
        conn.execute("update posts set status = %s, moderated_at = now() where id = %s", (status, row[0]))
    msg = (f"Live: {SITE}/t/{row[0]}" if status == "approved" else "Rejected: it stays hidden.")
    gh("issue", "comment", str(num), "--body", msg)
    gh("issue", "close", str(num))
    print(status, row[0])


if __name__ == "__main__":
    {"notify": notify, "decide": decide}[sys.argv[1]]()
