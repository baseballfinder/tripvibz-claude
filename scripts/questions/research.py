#!/usr/bin/env python3
"""
Question research for TripVibz: does each city question match what people
actually search (Bing) and post (Instagram hashtags)?

  python3 scripts/questions/research.py seeds            -> data/keywords/seeds.csv (for the Bing pull)
  python3 scripts/questions/research.py tags             -> prints the browser snippet that reads hashtag counts
  python3 scripts/questions/research.py score BING_DIR TAGS_JSON
                                                         -> data/keywords/question-scores.csv + summary
  python3 scripts/questions/research.py sql              -> SQL that makes the live questions match spec.py

Scoring (per question):
  search   = best Bing searches/month among its phrasings (window impressions / months in window)
  posts    = most Instagram posts among its hashtags
  demand   Strong: search >= 500 or posts >= 500K   Moderate: search >= 100 or posts >= 50K
           Weak: anything above zero                Not found: nothing on either
Lead question per city = the one with the most search; a city may pin a
different lead in spec.py by putting it first and adding pin_lead=True.
"""
import csv, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import spec  # noqa: E402

OUT = os.path.join(ROOT, "data", "keywords")


def opt_id(label):
    s = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return s[:24] or "opt"


def seeds(missing_only=False):
    """missing_only: skip phrasings that already have Bing data in data/keywords/ (saves API quota)."""
    os.makedirs(OUT, exist_ok=True)
    have = set()
    if missing_only:
        import glob
        for f in glob.glob(os.path.join(OUT, "*", "*", "keyword_window.csv")):
            have.update(r["keyword"] for r in csv.DictReader(open(f)))
    seen, rows = set(), []
    for slug, qs in spec.CITIES.items():
        for i, q in enumerate(qs, 1):
            for s in q["searches"]:
                if (s, slug) not in seen and s not in have:
                    seen.add((s, slug)); rows.append((s, slug, f"q{i}"))
    with open(os.path.join(OUT, "seeds.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["keyword", "group", "note"]); w.writerows(rows)
    print(len(rows), "seeds ->", os.path.join(OUT, "seeds.csv"))


def tags():
    t = sorted({x for qs in spec.CITIES.values() for q in qs for x in q["tags"]})
    print(f"// {len(t)} hashtags. Paste into the console of a signed-in instagram.com tab, wait, then copy(JSON.stringify(window.__tags))")
    print("const TAGS=" + json.dumps(t) + ";window.__tags={};(async()=>{for(const t of TAGS){const r=await fetch('/api/v1/tags/web_info/?tag_name='+t,{headers:{'x-ig-app-id':'936619743392459'},credentials:'include'});if(r.status===200){const j=await r.json();window.__tags[t]=(j.data&&j.data.media_count)??j.count??null}else if(r.status===429){await new Promise(s=>setTimeout(s,30000))}await new Promise(s=>setTimeout(s,1800+Math.random()*800))}window.__tagsDone=true})();")


def months_in(bing_dir):
    path = os.path.join(bing_dir, "keyword_stats.csv")
    weeks = {r["month"] for r in csv.DictReader(open(path))} if os.path.exists(path) else set()
    return max(len(weeks) * 7 / 30.4, 1.0) if weeks else 5.6


def tier(search, posts):
    if search >= 500 or posts >= 500_000: return "Strong"
    if search >= 100 or posts >= 50_000: return "Moderate"
    if search > 0 or posts > 0: return "Weak"
    return "Not found"


def score(bing_dirs, tags_json):
    """bing_dirs: one run folder, or several separated by commas (later runs win)."""
    win = {}
    for d in bing_dirs.split(","):
        mon = months_in(d)
        for r in csv.DictReader(open(os.path.join(d, "keyword_window.csv"))):
            win[r["keyword"]] = int(r["impressions"] or 0) / mon
    posts = json.load(open(tags_json))
    rows = []
    for slug, qs in spec.CITIES.items():
        for i, q in enumerate(qs, 1):
            pulled = [k for k in q["searches"] if k in win]
            s_best = max(pulled, key=lambda k: win[k]) if pulled else ""
            t_best = max(q["tags"], key=lambda k: posts.get(k) or 0) if q["tags"] else ""
            s, p = round(win.get(s_best, 0)), int(posts.get(t_best) or 0)
            d = tier(s, p)
            if not pulled:
                d += " (search not pulled yet)"
            rows.append({"city": slug, "position": i, "question": q["prompt"],
                         "top search": s_best, "Bing searches/month": s if pulled else "",
                         "top hashtag": "#" + t_best if t_best else "", "Instagram posts": p,
                         "demand": d})
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "question-scores.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    from collections import Counter
    print(Counter(r["demand"] for r in rows))
    for r in rows:
        if r["demand"].startswith(("Not found", "Weak")):
            print(f"  {r['demand']:9} {r['city']:16} {r['question']}  (search {r['Bing searches/month']}, posts {r['Instagram posts']})")
    print("->", path)


def sql():
    """Retire live questions that are not in spec (keeps their votes), reword
    matches in place, insert new ones. Matching: same city and same option labels."""
    def lit(s): return "'" + s.replace("'", "''") + "'"
    out = ["begin;"]
    for slug, qs in spec.CITIES.items():
        out.append(f"-- {slug}")
        out.append(f"update questions set active = false where city_id = (select id from cities where slug = {lit(slug)});")
        for i, q in enumerate(qs, 1):
            opts = json.dumps([{"id": opt_id(o), "label": o} for o in q["options"]])
            labels = json.dumps(sorted(q["options"]))
            # Reuse a row with the same option labels (rewording keeps votes valid).
            out.append(f"""with m as (
  select q.id from questions q where q.city_id = (select id from cities where slug = {lit(slug)}) and not q.active
   and (select jsonb_agg(e->>'label' order by e->>'label') from jsonb_array_elements(q.options) e) = {lit(labels)}::jsonb
   order by q.created_at limit 1)
update questions set prompt = {lit(q['prompt'])}, place_label = {lit(q['place'])}, sort = {i}, active = true where id in (select id from m);
insert into questions (city_id, prompt, options, place_label, sort, active)
select (select id from cities where slug = {lit(slug)}), {lit(q['prompt'])}, {lit(opts)}::jsonb, {lit(q['place'])}, {i}, true
where not exists (select 1 from questions where city_id = (select id from cities where slug = {lit(slug)}) and active and sort = {i});""")
    out.append("commit;")
    print("\n".join(out))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "seeds": seeds("--missing" in sys.argv)
    elif cmd == "tags": tags()
    elif cmd == "score": score(sys.argv[2], sys.argv[3])
    elif cmd == "sql": sql()
    else: print(__doc__)
