#!/usr/bin/env python3
"""
bing_keywords.py — pull keyword demand from the Bing Webmaster Tools API for a seed list.

Runs as the GitHub Action .github/workflows/bing-keywords.yml (manual trigger only — no
schedule until James approves one) and by hand. Deterministic: no LLM, no browser, no PC.
Writes CSV files only. It does NOT write D1 — no warehouse table has been assigned for this
data yet (ops/reference.md lists the single writer for every table; this source has none).

Vocabulary
  impressions        how many times Bing served a results page for the exact query — Bing's
                     stand-in for search volume. Not clicks, not Google.
  broad impressions  the same, counting queries that contain the term or a close variant.

Three Bing Webmaster API methods (Microsoft Learn, IWebmasterApi), all keyed by
(q, country, language):
  GetKeywordStats(q, country, language)                     -> monthly history per keyword
  GetRelatedKeywords(q, country, language, start, end)      -> related queries with impressions
  GetKeyword(q, country, language, start, end)              -> impressions for one window

Outputs, under BING_OUT_DIR (default out/bing/<run-date>):
  keyword_stats.csv      keyword, group, month, impressions, broad_impressions
  related_keywords.csv   seed, group, related_query, impressions, broad_impressions, window
  keyword_window.csv     keyword, group, impressions, broad_impressions, window
  run.json               counts, errors, which secret name was found (never its value)
  first_response.json    the first successful raw response, for shape debugging

Environment
  One of BING_WM_API_KEY / BING_WEBMASTER_API_KEY / BING_API_KEY / BING_KEY — the Bing
                     Webmaster Tools API key (Settings > API Access). First non-empty wins;
                     the run reports which name it used and the key's LENGTH only.
  BING_SEEDS         path to the seed CSV (columns: keyword, group, note).
                     Default warehouse/seeds/bing_keywords.csv
  BING_COUNTRY       default us        BING_LANGUAGE   default en-US
  BING_MONTHS        trailing months for the related/window calls. Default 12.
  BING_START/END     optional YYYY-MM-DD pair overriding BING_MONTHS (control pulls).
  BING_RELATED       1 (default) to call GetRelatedKeywords; 0 to skip it.
  BING_WINDOW        1 (default) to call GetKeyword;        0 to skip it.
  BING_RATE          seconds to sleep between calls. Default 0.3 (community client caps at 5/s).
  BING_OUT_DIR       output folder.

Secrets are never printed. Every URL carries the key as a query parameter, so URLs are never
logged either — errors are reported as (method, keyword, HTTP status, API message).
"""
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://ssl.bing.com/webmaster/api.svc/json/"
KEY_NAMES = ("BING_WM_API_KEY", "BING_WEBMASTER_API_KEY", "BING_API_KEY", "BING_KEY")
DATE_RE = re.compile(r"/Date\((-?\d+)(?:[+-]\d{4})?\)/")


# ----------------------------------------------------------------------------- helpers

def find_key():
    """First non-empty candidate secret. Returns (name, value). Reports lengths, never values."""
    seen = {}
    for name in KEY_NAMES:
        raw = os.environ.get(name)
        seen[name] = None if raw is None else len(raw.strip())
        if raw and raw.strip():
            return name, raw.strip(), seen
    raise RuntimeError(
        "No Bing API key found. Tried " + ", ".join(KEY_NAMES) + " — lengths seen: "
        + json.dumps(seen) + ". GitHub substitutes an EMPTY string when no secret matches the "
        "name; check Settings > Secrets and variables > Actions > Secrets (not Variables).")


def parse_wcf_date(v):
    """WCF JSON dates arrive as '/Date(1696118400000-0700)/'. Return YYYY-MM-DD, or the input."""
    if isinstance(v, str):
        m = DATE_RE.search(v)
        if m:
            ms = int(m.group(1))
            return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%d")
    return v


def mask(text, key):
    return text.replace(key, "***") if key and text else text


def call(method, params, key, timeout=60, retries=3):
    """One GET to the JSON endpoint. Returns (status, parsed_json_or_error_dict)."""
    q = dict(params)
    q["apikey"] = key
    url = BASE + method + "?" + urllib.parse.urlencode(q)
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                   "User-Agent": "miamitake-bing-keywords/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", errors="replace")
                try:
                    return r.status, json.loads(body)
                except json.JSONDecodeError:
                    return r.status, {"raw": mask(body[:500], key)}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body)
            except Exception:
                parsed = {"raw": mask(body[:500], key)}
            # Bing throttles with 400 + ErrorCode ThrottleUser/ThrottleHost; 429/5xx are generic.
            msg = json.dumps(parsed)
            if e.code in (429,) or e.code >= 500 or "Throttle" in msg:
                last = (e.code, parsed)
                time.sleep(min((2 ** attempt) * 2 + 0.5, 30))
                continue
            return e.code, parsed
        except (urllib.error.URLError, TimeoutError) as e:
            last = (0, {"error": mask(str(e), key)})
            time.sleep((2 ** attempt) + 0.5)
    return last if last else (0, {"error": "no response"})


def unwrap(payload):
    """WCF wraps results as {"d": ...}. Return the inner value, or the payload itself."""
    if isinstance(payload, dict) and "d" in payload and len(payload) == 1:
        return payload["d"]
    return payload


def rows_of(payload):
    inner = unwrap(payload)
    if inner is None:
        return []
    if isinstance(inner, list):
        return inner
    if isinstance(inner, dict):
        return [inner]
    return []


def err_text(payload):
    inner = unwrap(payload)
    if isinstance(inner, dict):
        for k in ("Message", "message", "ErrorCode", "error", "raw"):
            if k in inner:
                return f"{inner.get('ErrorCode', '')} {inner.get(k)}".strip()
    return json.dumps(inner)[:200]


def read_seeds(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    seeds = []
    for r in rows:
        kw = (r.get("keyword") or "").strip().lower()
        if kw:
            seeds.append({"keyword": kw, "group": (r.get("group") or "").strip(),
                          "note": (r.get("note") or "").strip()})
    return seeds


# ----------------------------------------------------------------------------- main

def main():
    key_name, key, lengths = find_key()
    seeds_path = os.environ.get("BING_SEEDS", "warehouse/seeds/bing_keywords.csv")
    country = os.environ.get("BING_COUNTRY", "us")
    language = os.environ.get("BING_LANGUAGE", "en-US")
    months = int(os.environ.get("BING_MONTHS", "12"))
    do_related = os.environ.get("BING_RELATED", "1") == "1"
    do_window = os.environ.get("BING_WINDOW", "1") == "1"
    rate = float(os.environ.get("BING_RATE", "0.3"))
    today = dt.date.today()
    out_dir = os.environ.get("BING_OUT_DIR", f"out/bing/{today.isoformat()}")
    os.makedirs(out_dir, exist_ok=True)

    # Window for the related / single-window calls: trailing N whole months ending last month.
    first_of_this_month = today.replace(day=1)
    end = first_of_this_month - dt.timedelta(days=1)
    start = (first_of_this_month - dt.timedelta(days=1)).replace(day=1)
    for _ in range(months - 1):
        start = (start - dt.timedelta(days=1)).replace(day=1)
    # Explicit override for control pulls (e.g. matching the weekly series exactly).
    if os.environ.get("BING_START") and os.environ.get("BING_END"):
        start = dt.date.fromisoformat(os.environ["BING_START"])
        end = dt.date.fromisoformat(os.environ["BING_END"])
    window = {"startDate": start.isoformat(), "endDate": end.isoformat()}
    window_label = f"{start.isoformat()}..{end.isoformat()}"

    seeds = read_seeds(seeds_path)
    print(f"bing_keywords: {len(seeds)} seeds from {seeds_path}; key from {key_name} "
          f"(length {len(key)}); country={country} language={language}; window {window_label}",
          file=sys.stderr)

    stats_rows, related_rows, window_rows, errors = [], [], [], []
    calls = 0
    first_response = None

    # 1. Auth / shape probe on the first seed. Fail fast with a clear message if the key is bad.
    probe_status, probe = call("GetKeywordStats",
                               {"q": seeds[0]["keyword"], "country": country, "language": language},
                               key)
    calls += 1
    if probe_status != 200:
        raise RuntimeError(f"Probe call failed: HTTP {probe_status} — {err_text(probe)}. "
                           f"InvalidApiKey means the secret value is wrong; a 404 means the base "
                           f"URL {BASE} is no longer right.")
    first_response = {"method": "GetKeywordStats", "keyword": seeds[0]["keyword"],
                      "payload": probe}

    def record_stats(seed, payload):
        for r in rows_of(payload):
            if not isinstance(r, dict):
                continue
            stats_rows.append({
                "keyword": seed["keyword"], "group": seed["group"],
                "month": parse_wcf_date(r.get("Date")),
                "impressions": r.get("Impressions"),
                "broad_impressions": r.get("BroadImpressions"),
                "query_returned": r.get("Query"),
            })

    record_stats(seeds[0], probe)
    time.sleep(rate)

    # 2. The rest of the seeds.
    for i, seed in enumerate(seeds):
        kw = seed["keyword"]
        base = {"q": kw, "country": country, "language": language}

        if i > 0:
            st, p = call("GetKeywordStats", base, key)
            calls += 1
            if st == 200:
                record_stats(seed, p)
            else:
                errors.append({"method": "GetKeywordStats", "keyword": kw, "status": st,
                               "error": err_text(p)})
            time.sleep(rate)

        if do_window:
            st, p = call("GetKeyword", {**base, **window}, key)
            calls += 1
            if st == 200:
                for r in rows_of(p):
                    if isinstance(r, dict):
                        window_rows.append({
                            "keyword": kw, "group": seed["group"],
                            "impressions": r.get("Impressions"),
                            "broad_impressions": r.get("BroadImpressions"),
                            "query_returned": r.get("Query"), "window": window_label,
                        })
            else:
                errors.append({"method": "GetKeyword", "keyword": kw, "status": st,
                               "error": err_text(p)})
            time.sleep(rate)

        if do_related:
            st, p = call("GetRelatedKeywords", {**base, **window}, key)
            calls += 1
            if st == 200:
                for r in rows_of(p):
                    if isinstance(r, dict):
                        related_rows.append({
                            "seed": kw, "group": seed["group"],
                            "related_query": r.get("Query"),
                            "impressions": r.get("Impressions"),
                            "broad_impressions": r.get("BroadImpressions"),
                            "window": window_label,
                        })
            else:
                errors.append({"method": "GetRelatedKeywords", "keyword": kw, "status": st,
                               "error": err_text(p)})
            time.sleep(rate)

    # 3. Write outputs.
    def write_csv(name, rows, fields):
        path = os.path.join(out_dir, name)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            for r in rows:
                w.writerow(r)
        return path

    write_csv("keyword_stats.csv", stats_rows,
              ["keyword", "group", "month", "impressions", "broad_impressions", "query_returned"])
    write_csv("keyword_window.csv", window_rows,
              ["keyword", "group", "impressions", "broad_impressions", "query_returned", "window"])
    write_csv("related_keywords.csv", related_rows,
              ["seed", "group", "related_query", "impressions", "broad_impressions", "window"])
    with open(os.path.join(out_dir, "first_response.json"), "w", encoding="utf-8") as f:
        json.dump(first_response, f, indent=1, default=str)

    seeds_with_stats = len({r["keyword"] for r in stats_rows})
    summary = {
        "run_date": today.isoformat(),
        "key_name_used": key_name,
        "key_lengths_seen": lengths,
        "country": country, "language": language, "window": window_label,
        "seeds": len(seeds),
        "calls": calls,
        "seeds_with_stats": seeds_with_stats,
        "stats_rows": len(stats_rows),
        "window_rows": len(window_rows),
        "related_rows": len(related_rows),
        "errors": errors,
        "out_dir": out_dir,
    }
    with open(os.path.join(out_dir, "run.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary))

    # Exit 1 only when nothing usable came back — per-keyword misses are reported, not fatal.
    if seeds_with_stats == 0:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — one JSON error line, red Action
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
