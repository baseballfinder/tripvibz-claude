/* City search (the Cities page, places.html). Pure functions, no page access,
   so tests/static.mjs runs the same code the browser does.

   What it fixes over a plain "contains" match:
   - full state names and abbreviations both work ("Florida" and "FL");
   - nicknames people actually type (NYC, Vegas, NOLA, SF, Waikiki…);
   - Saint/St., Fort/Ft., Mount/Mt. and punctuation don't matter;
   - small typos ("Ashville", "Savanah", "Pheonix");
   - results are ranked: exact or nickname, then name starts with it, then a
     word in the name starts with it, then contains it, then typo matches.

   TVSearch.search(query, cities, requestable) ->
     { state: {code, name, count} | null, results: [{ kind: "city"|"request", item, score, hl }] }
   `hl` marks the typed part of the name, so the page can make the rest bold
   (Baymard: emphasize what the suggestion adds, not what was typed). */
(function (root) {
  "use strict";

  var STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
    DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
    VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
  };

  // Nicknames -> city slug. Only names people use for the city itself.
  var ALIASES = {
    "nyc": "new-york", "new york city": "new-york", "manhattan": "new-york", "the big apple": "new-york", "big apple": "new-york",
    "vegas": "las-vegas", "lv": "las-vegas", "sin city": "las-vegas",
    "nola": "new-orleans", "the big easy": "new-orleans", "big easy": "new-orleans",
    "sf": "san-francisco", "san fran": "san-francisco", "frisco": "san-francisco", "the bay": "san-francisco",
    "sd": "san-diego", "atx": "austin", "music city": "nashville", "nash": "nashville",
    "chi": "chicago", "chitown": "chicago", "chi town": "chicago", "windy city": "chicago",
    "south beach": "miami-beach", "sobe": "miami-beach", "mia": "miami", "the 305": "miami", "305": "miami",
    "lauderdale": "fort-lauderdale", "ftl": "fort-lauderdale", "fll": "fort-lauderdale",
    "waikiki": "honolulu", "oahu": "honolulu", "hnl": "honolulu",
    "disney": "orlando", "disney world": "orlando", "mco": "orlando",
    "daytona": "daytona-beach", "siesta key": "sarasota", "mile high": "denver", "the mile high city": "denver",
    "the conch republic": "key-west", "conch republic": "key-west", "the holy city": "charleston", "chs": "charleston",
    // Cities people can ask for (city_candidates).
    "la": "los-angeles", "lax": "los-angeles", "philly": "philadelphia", "dc": "washington-dc", "washington dc": "washington-dc",
    "atl": "atlanta", "hotlanta": "atlanta", "beantown": "boston", "big d": "dallas", "htown": "houston", "h town": "houston",
    "indy": "indianapolis", "okc": "oklahoma-city", "kc": "kansas-city", "stl": "st-louis", "slc": "salt-lake-city",
    "twin cities": "minneapolis", "pdx": "portland", "saint pete": "st-petersburg", "st pete": "st-petersburg", "jax": "jacksonville"
  };

  // Lowercase, no accents or punctuation, Saint/Fort/Mount spelled out.
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[.'’]/g, "").replace(/[^a-z0-9]+/g, " ").trim()
      .replace(/\bst\b/g, "saint").replace(/\bft\b/g, "fort").replace(/\bmt\b/g, "mount");
  }

  // Optimal string alignment distance (Levenshtein + swapped neighbours), capped.
  function dist(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var prev2 = null, prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i]; var best = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < best) best = v;
      }
      if (best > cap) return cap + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }
  // How many typos we forgive for a query of this length.
  function allowed(len) { return len < 4 ? 0 : len < 8 ? 1 : 2; }

  // Which state the query names, if any ("fl", "florida", "flor" once 4+ letters).
  function stateOf(q) {
    if (!q) return null;
    var up = q.toUpperCase();
    if (up.length === 2 && STATES[up]) return up;
    for (var code in STATES) {
      var n = norm(STATES[code]);
      if (n === q || (q.length >= 4 && n.indexOf(q) === 0)) return code;
    }
    return null;
  }

  // Score one name against the query. Higher is better; 0 = no match. Also where the typed part is.
  function scoreName(q, name) {
    var n = norm(name);
    if (!q || !n) return { s: 0 };
    if (n === q) return { s: 100, hl: [0, n.length] };
    if (n.indexOf(q) === 0) return { s: 90, hl: [0, q.length] };
    var words = n.split(" "), off = 0;
    for (var w = 0; w < words.length; w++) {
      if (w > 0 && words[w].indexOf(q) === 0) return { s: 80, hl: [off, off + q.length] };
      off += words[w].length + 1;
    }
    // Inside a word ("ville" in Nashville): weaker than a one-letter typo of the whole name.
    var at = n.indexOf(q);
    if (at > 0 && q.length >= 3) return { s: 40, hl: [at, at + q.length] };
    // Typos: against the whole name, its start (still typing), or one of its words.
    var cap = allowed(q.length);
    if (cap) {
      var d = dist(q, n, cap);
      for (var k = -1; k <= 1 && d > cap; k++) if (q.length + k > 0 && q.length + k <= n.length) d = Math.min(d, dist(q, n.slice(0, q.length + k), cap));
      for (w = 0; w < words.length && d > cap; w++) if (words[w].length >= 4) d = Math.min(d, dist(q, words[w], cap));
      if (d <= cap) return { s: d === 1 ? 45 : 35 };
    }
    return { s: 0 };
  }

  // Character range in the displayed name that matches the typed part.
  // norm() only drops punctuation and expands St/Ft/Mt, so map back by walking both strings.
  function hlFor(display, q) {
    var shown = String(display), lower = shown.toLowerCase(), raw = String(q || "").toLowerCase().trim();
    var at = lower.indexOf(raw);
    if (raw && at >= 0) return [at, at + raw.length];
    return null;
  }

  function search(query, cities, requestable) {
    var q = norm(query);
    var out = { state: null, results: [] };
    if (!q) return out;
    var code = stateOf(q);
    var aliasSlug = ALIASES[q] || null;
    var seen = {};
    function add(kind, item) {
      if (seen[item.slug]) return;
      var r = scoreName(q, item.name);
      var s = r.s;
      if (aliasSlug && item.slug === aliasSlug) s = Math.max(s, 95);
      if (code && item.state === code) s = Math.max(s, 60);
      if (!s) return;
      seen[item.slug] = 1;
      out.results.push({ kind: kind, item: item, score: s, hl: s >= 40 ? hlFor(item.name, query) : null });
    }
    (cities || []).forEach(function (c) { add("city", c); });
    (requestable || []).forEach(function (c) { add("request", c); });
    if (code) {
      var n = (cities || []).filter(function (c) { return c.state === code; }).length;
      if (n) out.state = { code: code, name: STATES[code], count: n };
    }
    out.results.sort(function (a, b) {
      return b.score - a.score
        || (a.kind === b.kind ? 0 : a.kind === "city" ? -1 : 1)
        || ((b.item.take_count || 0) - (a.item.take_count || 0))
        || String(a.item.name).localeCompare(String(b.item.name));
    });
    return out;
  }

  // Cities nearest a point, within `maxMi` miles, closest first.
  function nearest(lat, lng, cities, maxMi, limit) {
    var R = 3958.8, r = function (d) { return d * Math.PI / 180; };
    return (cities || []).filter(function (c) { return Number.isFinite(+c.lat) && Number.isFinite(+c.lng); }).map(function (c) {
      var dLat = r(c.lat - lat), dLng = r(c.lng - lng);
      var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(r(lat)) * Math.cos(r(c.lat)) * Math.pow(Math.sin(dLng / 2), 2);
      return { item: c, mi: 2 * R * Math.asin(Math.sqrt(h)) };
    }).filter(function (x) { return x.mi <= (maxMi || 150); }).sort(function (a, b) { return a.mi - b.mi; }).slice(0, limit || 2);
  }

  // States that have cities, most cities first: the quick-pick row.
  function stateCounts(cities) {
    var by = {};
    (cities || []).forEach(function (c) { if (c.state) by[c.state] = (by[c.state] || 0) + 1; });
    return Object.keys(by).map(function (k) { return { code: k, name: STATES[k] || k, count: by[k] }; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  root.TVSearch = { STATES: STATES, ALIASES: ALIASES, norm: norm, dist: dist, stateOf: stateOf, search: search, nearest: nearest, stateCounts: stateCounts };
})(typeof window !== "undefined" ? window : globalThis);
