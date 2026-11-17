/* ==========================================================================
   TripVibz — the live site log on the admin page (admin.html only).

   Reads public.site_log through admin_site_log() (admins only) and keeps
   asking for anything newer every few seconds while the tab is in view.
   The functions that turn rows into visits and sentences are plain and
   exported on window.TVLog so tests/static.mjs can run them.
   ========================================================================== */
(function () {
  "use strict";

  var ERROR_KINDS = ["error", "request_failed", "function_error", "not_found", "slow"];
  var KIND_LABEL = { error: "Script error", request_failed: "Save or request failed", function_error: "Server error", not_found: "Page not found", slow: "Slow response" };
  var DEVICE_LABEL = { phone: "Phone", tablet: "Tablet", desktop: "Computer", bot: "Bot" };
  var ACTIVE_MS = 5 * 60 * 1000;   // a visit with something in the last 5 minutes counts as "on the site now"
  var POLL_MS = 5000;
  var CLARITY_PLAYER = "https://clarity.microsoft.com/player/";
  var RECORDING_READY_MS = 2 * 3600 * 1000;   // a recording can take up to about two hours to show up in Clarity
  var RANGES = [["1h", "Last hour", 3600e3], ["24h", "Last 24 hours", 86400e3], ["7d", "Last 7 days", 7 * 86400e3], ["30d", "Last 30 days", 30 * 86400e3]];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /** "45 s", "3 min", "1 h 12 min". */
  function duration(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + " s";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  /**
   * Rows (any order) -> visits, newest activity first. A visit is every row
   * that shares a session id: where it started, where it came from, the pages
   * in the order they were opened, how long it lasted (first row to last, or
   * to the end of the last page when the browser told us), and its errors.
   */
  function groupVisits(rows) {
    var by = {};
    rows.slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (r) {
      if (!r.session_id) return;
      var at = Date.parse(r.at);
      var v = by[r.session_id] || (by[r.session_id] = { id: r.session_id, start: at, last: at, landing: null, source: null, place: null, device: null, pages: [], errors: 0, complete: false });
      v.last = Math.max(v.last, at); v.start = Math.min(v.start, at);
      if (!v.seen) v.seen = r.path;   // for a visit whose opening rows are older than the period on screen
      if (r.place && !v.place) v.place = r.place;
      if (r.device && !v.device) v.device = r.device;
      if (r.kind === "visit") {
        v.complete = true; v.source = r.source || "Direct"; v.landing = r.path;
        // Visits from before the log existed were loaded from Microsoft Clarity (Nov 17 2026);
        // each carries the address of its Clarity recording.
        if (r.message === "Imported from Clarity") v.imported = true;
      }
      // A recording address arrives on the visit row (imported visits) or on a leave row (live visits).
      if ((r.kind === "visit" || r.kind === "leave") && typeof r.detail === "string" && r.detail.indexOf(CLARITY_PLAYER) === 0) v.recording = r.detail;
      if (r.kind === "visit" || r.kind === "page") { if (v.pages[v.pages.length - 1] !== r.path) v.pages.push(r.path); if (!v.landing) v.landing = r.path; }
      if (ERROR_KINDS.indexOf(r.kind) >= 0 && r.kind !== "slow") v.errors++;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.last - a.last; });
  }

  /** "Tampa, FL, US" -> { city, region, country }. Cloudflare leaves out what it doesn't know. */
  function parsePlace(place) {
    var p = String(place || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var out = { city: "", region: "", country: "" };
    if (!p.length) return out;
    out.country = p.pop();
    if (p.length === 2) { out.city = p[0]; out.region = p[1]; }
    else if (p.length === 1) { if (/^[A-Z0-9]{1,3}$/.test(p[0])) out.region = p[0]; else out.city = p[0]; }
    else if (p.length > 2) { out.region = p.pop(); out.city = p.join(", "); }
    return out;
  }

  /** 'Bing · searched "miami in july"' and "Google (kit / tv-miami)" -> "Bing", "Google": one name per source. */
  function sourceBase(source) {
    var s = String(source || "");
    if (!s) return "";
    return s.replace(/ · searched ".*$/, "").replace(/ \(.*\)$/, "") || s;
  }

  /** Does a visit, or a single error row, pass the filters? Empty filter = anything. Works on both: each has place and device. */
  function passes(item, f, source) {
    var pl = parsePlace(item.place);
    if (f.device && (item.device || "unknown") !== f.device) return false;
    if (f.country && pl.country !== f.country) return false;
    if (f.region && pl.region !== f.region) return false;
    if (f.city && pl.city !== f.city) return false;
    if (f.source && sourceBase(source) !== f.source) return false;
    if (f.recording && !item.recording) return false;
    return true;
  }
  function filterVisits(visits, f) { return visits.filter(function (v) { return passes(v, f, v.complete ? v.source : ""); }); }

  /** What each filter can offer, from the visits on hand: value and how many visits have it, most first. */
  function facets(visits) {
    var out = { device: {}, source: {}, country: {}, region: {}, city: {} };
    visits.forEach(function (v) {
      var pl = parsePlace(v.place), add = function (k, val) { if (val) out[k][val] = (out[k][val] || 0) + 1; };
      add("device", v.device || "unknown"); add("source", v.complete ? sourceBase(v.source) : "");
      add("country", pl.country); add("region", pl.region); add("city", pl.city);
    });
    Object.keys(out).forEach(function (k) {
      out[k] = Object.keys(out[k]).map(function (val) { return [val, out[k][val]]; }).sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
    });
    return out;
  }

  /** The numbers on top: on the site now, visits and errors in the rows on hand. */
  function summary(rows, now) {
    var visits = groupVisits(rows);
    return {
      now: visits.filter(function (v) { return now - v.last <= ACTIVE_MS && v.device !== "bot"; }).length,
      visits: visits.filter(function (v) { return v.device !== "bot"; }).length,
      errors: rows.filter(function (r) { return ERROR_KINDS.indexOf(r.kind) >= 0 && r.kind !== "slow" && r.kind !== "not_found"; }).length,
      missing: rows.filter(function (r) { return r.kind === "not_found"; }).length
    };
  }

  function clock(at) {
    var d = new Date(at), today = new Date().toDateString() === d.toDateString();
    var t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    return today ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
  }

  function visitHtml(v, now) {
    var live = now - v.last <= ACTIVE_MS;
    var len = v.last - v.start;
    return '<div class="lg-row' + (v.errors ? " has-err" : "") + '" data-k="v' + esc(v.id) + '">' +
      '<div class="lg-top"><span class="lg-time">' + esc(clock(v.start)) + "</span>" +
      (live ? '<span class="lg-pill live">On the site now</span>' : "") +
      '<span class="lg-pill">' + esc(DEVICE_LABEL[v.device] || "Unknown device") + "</span>" +
      (v.place ? '<span class="lg-where">' + esc(v.place) + "</span>" : "") +
      (v.imported ? '<span class="lg-pill">From Clarity</span>' : "") +
      (v.errors ? '<span class="lg-pill err">' + v.errors + (v.errors === 1 ? " error" : " errors") + "</span>" : "") + "</div>" +
      '<div class="lg-main">' + (v.complete ? "From <b>" + esc(v.source) + "</b>" : "Started before this list begins") + "</div>" +
      '<div class="lg-trail">' + (v.pages.length ? v.pages : [v.seen]).map(function (p) { return '<a href="' + esc(p) + '" target="_blank" rel="noopener">' + esc(p) + "</a>"; }).join(" → ") + "</div>" +
      '<div class="lg-meta">' + (v.pages.length ? v.pages.length + (v.pages.length === 1 ? " page" : " pages") + " · " : "") + (len < 1000 ? "less than a second so far" : duration(len) + " on the site") +
      (v.recording ? ' · <a href="' + esc(v.recording) + '" target="_blank" rel="noopener">Watch the Clarity recording</a>' +
        // Clarity needs time to prepare a recording after the visit ends; until then its player shows nothing.
        (now - v.last < RECORDING_READY_MS ? " (Clarity is still preparing it; try again in a while)" : "") : "") + "</div></div>";
  }

  function errorHtml(r) {
    var line = r.kind === "request_failed" ? (r.detail || "") + (r.status ? " answered " + r.status : " got no answer") + (r.message ? ": " + r.message : "")
      : r.kind === "not_found" ? (r.source ? "Linked from " + r.source : "No linking page given (typed, bookmarked, or hidden by the other site)")
      : (r.message || "");
    var more = r.kind === "error" || r.kind === "function_error" ? r.detail : "";
    return '<div class="lg-row is-' + r.kind + '" data-k="e' + esc(r.id) + '">' +
      '<div class="lg-top"><span class="lg-time">' + esc(clock(Date.parse(r.at))) + "</span>" +
      '<span class="lg-pill ' + (r.kind === "slow" || r.kind === "not_found" ? "warn" : "err") + '">' + esc(KIND_LABEL[r.kind] || r.kind) + "</span>" +
      (r.device ? '<span class="lg-pill">' + esc(DEVICE_LABEL[r.device] || r.device) + "</span>" : "") +
      (r.place ? '<span class="lg-where">' + esc(r.place) + "</span>" : "") + "</div>" +
      '<div class="lg-main"><a href="' + esc(r.path) + '" target="_blank" rel="noopener">' + esc(r.path) + "</a></div>" +
      (line ? '<div class="lg-msg">' + esc(line) + "</div>" : "") +
      (more ? "<details><summary>Where in the code</summary><pre>" + esc(more) + "</pre></details>" : "") + "</div>";
  }

  /** Draw the panel into `el` and keep it current. sb = the signed-in admin's Supabase client. */
  function mount(el, sb) {
    var rows = [], seen = {}, newest = 0, view = "visits", range = "24h", paused = false, failing = "", timer = null, bots = false;
    var F = { device: "", source: "", country: "", region: "", city: "", recording: false };
    var FILTERS = [["source", "Any source"], ["device", "Any device"], ["country", "Any country"], ["region", "Any state or region"], ["city", "Any city"]];
    function select(key, label, options) {
      // Keep a chosen value in the list even when the period on screen no longer has it, so it can be cleared.
      if (F[key] && !options.some(function (o) { return o[0] === F[key]; })) options = options.concat([[F[key], 0]]);
      return '<select data-lgf="' + key + '" aria-label="' + label + '"><option value="">' + label + "</option>" + options.map(function (o) {
        var name = key === "device" ? (DEVICE_LABEL[o[0]] || "Unknown device") : o[0];
        return '<option value="' + esc(o[0]) + '"' + (o[0] === F[key] ? " selected" : "") + ">" + esc(name) + " (" + o[1] + ")</option>";
      }).join("") + "</select>";
    }

    function since() { var r = RANGES.filter(function (x) { return x[0] === range; })[0]; return new Date(Date.now() - r[2]).toISOString(); }

    function draw() {
      var now = Date.now(), shown = bots ? rows : rows.filter(function (r) { return r.device !== "bot"; });
      var all = groupVisits(shown), fc = facets(all), visits = filterVisits(all, F);
      var active = FILTERS.some(function (x) { return F[x[0]]; }) || F.recording;
      // The numbers follow the filters: only rows that belong to a visit still showing, or pass on their own.
      var keep = {}; visits.forEach(function (v) { keep[v.id] = 1; });
      var inView = !active ? shown : shown.filter(function (r) { return r.session_id ? keep[r.session_id] : (!F.source && !F.recording && passes(r, F, "")); });
      var s = summary(inView, now);
      var errs = inView.filter(function (r) { return ERROR_KINDS.indexOf(r.kind) >= 0; }).sort(function (a, b) { return b.id - a.id; });
      var list = view === "visits" ? visits.map(function (v) { return visitHtml(v, now); }) : errs.map(errorHtml);
      var off = false; try { off = localStorage.getItem("tv_nolog") === "1"; } catch (e) { /* storage blocked */ }
      // Six parts, each replaced only when its own content changed. A check that brings nothing new
      // therefore touches nothing: the scroll position, an open list, the pointer's hover all stay put.
      patch("head", '<h2>Live site log</h2>' +
        '<span class="lg-state ' + (failing ? "bad" : paused ? "" : "on") + '">' + (failing ? "Can't reach the log: " + esc(failing) : paused ? "Paused" : "Live · checks every 5 seconds") + "</span>" +
        '<button data-lg="pause">' + (paused ? "Resume" : "Pause") + "</button>");
      patch("nums", "<div><b>" + s.now + "</b>on the site now</div><div><b>" + s.visits + "</b>visits</div><div><b>" + s.errors + "</b>errors</div><div><b>" + s.missing + "</b>pages not found</div>");
      patch("tools", '<button data-lg="visits" aria-pressed="' + (view === "visits") + '">Visits (' + visits.length + ")</button>" +
        '<button data-lg="errors" aria-pressed="' + (view === "errors") + '">Errors and missing pages (' + errs.length + ")</button>" +
        '<select data-lg="range" aria-label="How far back">' + RANGES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === range ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") + "</select>" +
        '<label><input type="checkbox" data-lg="bots"' + (bots ? " checked" : "") + "> Show bots</label>" +
        '<label><input type="checkbox" data-lg="nolog"' + (off ? " checked" : "") + "> Leave out this browser's visits</label>");
      patch("filters", FILTERS.map(function (x) { return select(x[0], x[1], fc[x[0]]); }).join("") +
        '<label><input type="checkbox" data-lgf="recording"' + (F.recording ? " checked" : "") + "> Has a Clarity recording</label>" +
        (active ? '<button data-lg="clear">Clear filters</button>' : ""));
      patch("list", list.length ? list.slice(0, 200).join("") : '<div class="lg-empty">' + (active ? "Nothing in this period matches these filters." : view === "visits" ? "No visits in this period yet. A visit shows here within a few seconds of someone opening a page." : "No errors or missing pages in this period.") + "</div>",
        view + "|" + range + "|" + bots + "|" + JSON.stringify(F));
      patch("foot", (list.length > 200 ? '<div class="lg-empty">Showing the newest 200 of ' + list.length + ".</div>" : "") +
        (rows.length >= 2000 ? '<div class="lg-empty">This period holds more than the 2,000 newest entries loaded here; pick a shorter period to see all of it.</div>' : ""));
    }

    // The panel's parts, made once. PART[name] = { node, html (what it holds), ctx }.
    var PART = {};
    [["head", "lg-head"], ["nums", "lg-nums"], ["tools", "lg-tools"], ["filters", "lg-tools lg-filters"], ["list", "lg-list"], ["foot", "lg-foot"]].forEach(function (x) {
      var node = document.createElement("div"); node.className = x[1]; el.appendChild(node);
      PART[x[0]] = { node: node, html: null, ctx: null };
    });

    /**
     * Put `html` in a part, unless it already holds exactly that.
     *  - A part with a dropdown the person has open or focused waits: replacing it would close the dropdown
     *    under their pointer. It catches up on the next draw after they pick or move on.
     *  - The list keeps its place: opened "Where in the code" boxes stay open, and when new entries arrive on
     *    top while the person has scrolled down, the entries they were reading stay where they were.
     *    ctx (view, period, filters) says whether it is still the same list; a different one starts at the top.
     */
    function patch(name, html, ctx) {
      var p = PART[name], node = p.node;
      if (p.html === html) return;
      var focus = document.activeElement;
      if (focus && focus.tagName === "SELECT" && node.contains(focus) && p.html !== null) return;
      if (name !== "list") { node.innerHTML = html; p.html = html; return; }
      var same = p.ctx === ctx, top = node.scrollTop, height = node.scrollHeight, open = {};
      if (same) Array.prototype.forEach.call(node.querySelectorAll("[data-k] details[open]"), function (d) { open[d.closest("[data-k]").getAttribute("data-k")] = 1; });
      node.innerHTML = html; p.html = html; p.ctx = ctx;
      if (!same) { node.scrollTop = 0; return; }
      Array.prototype.forEach.call(node.querySelectorAll("[data-k] details"), function (d) { if (open[d.closest("[data-k]").getAttribute("data-k")]) d.open = true; });
      // Scrolled down: new entries were added above, so move down by as much as the list grew. At the top: stay at the top.
      node.scrollTop = top > 0 ? Math.max(0, top + (node.scrollHeight - height)) : 0;
    }

    function take(data) {
      (data || []).forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; rows.push(r); if (r.id > newest) newest = r.id; } });
    }
    function load(fresh) {
      if (fresh) { rows = []; seen = {}; newest = 0; }
      return sb.rpc("admin_site_log", { p_after: newest, p_since: since(), p_limit: fresh ? 2000 : 500 }).then(function (res) {
        if (res.error) throw res.error;
        failing = ""; take(res.data);
        var cut = Date.parse(since()); rows = rows.filter(function (r) { return Date.parse(r.at) >= cut; });
        draw();
      }).catch(function (e) { failing = (e && e.message) || "no answer"; draw(); });
    }
    function tick() { if (!paused && document.visibilityState !== "hidden") load(false); }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-lg]"); if (!b) return;
      var a = b.getAttribute("data-lg");
      if (a === "pause") { paused = !paused; draw(); if (!paused) load(false); }
      else if (a === "clear") { F = { device: "", source: "", country: "", region: "", city: "", recording: false }; draw(); }
      else { view = a; draw(); }
    });
    el.addEventListener("change", function (e) {
      var fk = e.target.getAttribute("data-lgf");
      if (fk) { F[fk] = fk === "recording" ? e.target.checked : e.target.value; draw(); return; }
      var a = e.target.getAttribute("data-lg");
      if (a === "range") { range = e.target.value; load(true); }
      else if (a === "bots") { bots = e.target.checked; draw(); }
      else if (a === "nolog") { try { e.target.checked ? localStorage.setItem("tv_nolog", "1") : localStorage.removeItem("tv_nolog"); } catch (err) { /* storage blocked */ } }
    });
    // A part that waited for an open dropdown catches up once the dropdown lets go.
    el.addEventListener("focusout", function (e) { if (e.target && e.target.tagName === "SELECT") setTimeout(draw, 0); });
    draw();
    load(true);
    timer = setInterval(tick, POLL_MS);
    return { stop: function () { clearInterval(timer); }, refresh: function () { return load(false); } };
  }

  window.TVLog = { parsePlace: parsePlace, sourceBase: sourceBase, filterVisits: filterVisits, facets: facets, groupVisits: groupVisits, summary: summary, duration: duration, visitHtml: visitHtml, errorHtml: errorHtml, mount: mount, ERROR_KINDS: ERROR_KINDS, ACTIVE_MS: ACTIVE_MS };
})();
