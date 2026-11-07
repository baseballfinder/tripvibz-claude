/* The Guide tab on city pages (assets/city.js) and its pre-rendered copy
   (build.mjs loads this file with node:vm, like search.js and v2.js, so both
   draw the same markup from the same rules).

   What it shows, top to bottom:
   1. A map of the spots people's takes are about and the top restaurant
      picks. The map library (Leaflet, /assets/leaflet-1.9.4.js) and the
      OpenStreetMap tiles only load when someone opens the Guide, so city
      pages don't get heavier.
   2. Top restaurants: the city's top 3 picks, how many people picked each
      (and how many of them are verified locals), and what they said.
   3. Spots in the takes: each place, its takes, linked.
   4. Where to stay (Stay22), added by the caller.

   TVGuide.spots(posts, places)  -> [{ place, takes }]   most takes first
   TVGuide.topEats(rows, picks, verified, nameOf, n) -> [{ row, people, verifiedPeople, reviews }]
   TVGuide.html(city, spots, eats, opts)  -> markup
   TVGuide.mountMap(root)          -> loads the map into [data-guide-map] (browser only) */
(function (root) {
  "use strict";

  var MAP_JS = "/assets/leaflet-1.9.4.js", MAP_CSS = "/assets/leaflet-1.9.4.css";
  var TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var MAP_TIMEOUT_MS = 8000;      // give up on the map (keep the lists) after this
  var REVIEWS_SHOWN = 3;
  // "Spots" that are the whole place or a trip out of it, not somewhere to pin.
  var NOT_A_SPOT = /^(whole (city|island)|everywhere|getting to .*)$/i;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ok(n) { return typeof n === "number" ? isFinite(n) : n != null && n !== "" && isFinite(+n); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  // Takes grouped by the spot they're pinned to. Only spots with a position.
  function spots(posts, places) {
    var byId = {};
    (places || []).forEach(function (p) { if (p && p.id && ok(p.lat) && ok(p.lng) && !NOT_A_SPOT.test(p.name || "")) byId[p.id] = p; });
    var groups = {};
    (posts || []).forEach(function (t) {
      var pl = t && t.place_id && byId[t.place_id];
      if (!pl || (t.status && t.status !== "approved")) return;
      (groups[pl.id] = groups[pl.id] || { place: pl, takes: [] }).takes.push(t);
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.takes.sort(function (a, b) { return ((b.ups || 0) - (b.downs || 0)) - ((a.ups || 0) - (a.downs || 0)); });
      return g;
    }).sort(function (a, b) { return b.takes.length - a.takes.length || String(a.place.name).localeCompare(String(b.place.name)); });
  }

  // The top restaurants (same order as the Eat tab), with who picked them and why.
  // rows: city_top_restaurants for one city; picks: top3_picks for that city;
  // verified: Set of verified-local user ids; nameOf(user_id) -> display name.
  function topEats(rows, picks, verified, nameOf, n) {
    var v = verified || { has: function () { return false; } };
    var sorted = (rows || []).slice().sort(function (a, b) {
      return (b.verified_points || 0) - (a.verified_points || 0) || (b.points || 0) - (a.points || 0) ||
        (b.firsts || 0) - (a.firsts || 0) || String(a.name).localeCompare(String(b.name));
    });
    return sorted.slice(0, n || 3).map(function (r) {
      var mine = (picks || []).filter(function (p) { return p.restaurant_id === r.restaurant_id; });
      var people = {}, vp = {};
      mine.forEach(function (p) { people[p.user_id] = 1; if (v.has(p.user_id)) vp[p.user_id] = 1; });
      var reviews = mine.filter(function (p) { return p.why && String(p.why).trim(); })
        .sort(function (a, b) { return (v.has(b.user_id) - v.has(a.user_id)) || a.rank - b.rank; })
        .map(function (p) { return { why: String(p.why).trim(), by: nameOf ? nameOf(p.user_id) : "", verified: v.has(p.user_id), rank: p.rank }; });
      return { row: r, people: Object.keys(people).length || r.picks || 0, verifiedPeople: Object.keys(vp).length, reviews: reviews };
    });
  }

  // Everything the map draws, as plain data (kept in the markup so the map needs no second fetch).
  function points(sp, eats) {
    var out = [];
    (eats || []).forEach(function (e, i) {
      var r = e.row;
      if (ok(r.lat) && ok(r.lng)) out.push({ k: "eat", n: i + 1, name: r.name, lat: +r.lat, lng: +r.lng, sub: "Picked by " + plural(e.people, "person", "people") });
    });
    (sp || []).forEach(function (g) {
      var t = g.takes[0];
      out.push({ k: "spot", name: g.place.name, lat: +g.place.lat, lng: +g.place.lng, sub: plural(g.takes.length, "take"),
        take: t ? { id: t.id, title: String(t.title || "").slice(0, 120) } : null });
    });
    return out;
  }

  function directions(lat, lng) {
    return "https://www.google.com/maps/dir/?api=1&amp;destination=" + encodeURIComponent(lat + "," + lng);
  }

  // opts: { stayHtml, hotelsNear(name) -> url|null, addHref }
  function html(city, sp, eats, opts) {
    opts = opts || {};
    var pts = points(sp, eats);
    var people = opts.pickers || 0;
    var nTakes = (sp || []).reduce(function (n, g) { return n + g.takes.length; }, 0);
    var sub = [];
    if (sp && sp.length) sub.push(plural(sp.length, "spot") + " from " + plural(nTakes, "take"));
    if (people) sub.push(plural(people, "person", "people") + " picked restaurants");

    var map = pts.length ? '<div class="g-map" data-guide-map data-points="' + esc(JSON.stringify(pts)) + '" role="region" aria-label="Map of ' + esc(city.name) + ' spots and restaurants">' +
        '<div class="g-map-wait">Loading the map…</div></div>' +
        '<div class="g-legend"><span><i class="g-dot eat"></i>Top restaurants</span><span><i class="g-dot spot"></i>Spots in the takes</span></div>'
      : "";

    var eatList = (eats && eats.length) ? '<ol class="g-eats">' + eats.map(function (e, i) {
      var r = e.row, links = [];
      if (ok(r.lat) && ok(r.lng)) links.push('<a href="' + directions(r.lat, r.lng) + '" target="_blank" rel="noopener">Directions</a>');
      var h = opts.hotelsNear && opts.hotelsNear(r.name);
      if (h) links.push('<a href="' + esc(h) + '" target="_blank" rel="noopener sponsored">Hotels near</a>');
      var shown = e.reviews.slice(0, REVIEWS_SHOWN), more = e.reviews.length - shown.length;
      return '<li class="g-eat"><span class="g-n" aria-hidden="true">' + (i + 1) + '</span><div class="g-body">' +
        '<b class="g-name">' + esc(r.name) + "</b>" +
        ((r.address || r.neighborhood) ? '<span class="g-addr">' + esc([r.address, r.neighborhood].filter(Boolean).join(", ")) + "</span>" : "") +
        '<div class="g-count">Picked by ' + plural(e.people, "person", "people") + (e.verifiedPeople ? " · " + e.verifiedPeople + " verified ✓" : "") + "</div>" +
        (shown.length ? '<ul class="g-reviews">' + shown.map(function (w) {
          return '<li>“' + esc(w.why) + '”' + (w.by ? ' <span class="g-by">— ' + esc(w.by) + (w.verified ? " ✓" : "") + "</span>" : "") + "</li>";
        }).join("") + (more > 0 ? '<li class="g-more">and ' + plural(more, "more review") + " on the Eat tab</li>" : "") + "</ul>"
          : '<div class="g-noreview">No reviews yet, just picks.</div>') +
        (links.length ? '<div class="eat-links">' + links.join("") + "</div>" : "") +
        "</div></li>";
    }).join("") + "</ol>"
      : '<div class="empty2"><b>No restaurant picks yet</b>Know ' + esc(city.name) + '? <a href="/' + esc(city.slug) + '/#top3">Name the three places you\'d take a friend to eat.</a></div>';

    var spotList = (sp && sp.length) ? '<ul class="g-spots">' + sp.map(function (g) {
      return '<li class="g-spot"><div class="g-spot-h"><b class="g-name">' + esc(g.place.name) + '</b><span class="g-count">' + plural(g.takes.length, "take") + "</span></div>" +
        '<ul class="g-takes">' + g.takes.slice(0, 3).map(function (t) {
          return '<li><a href="/t/' + esc(t.id) + '">' + esc(t.title) + "</a></li>";
        }).join("") + "</ul>" +
        '<div class="eat-links"><a href="' + directions(g.place.lat, g.place.lng) + '" target="_blank" rel="noopener">Directions</a></div></li>';
    }).join("") + "</ul>"
      : '<div class="empty2"><b>No spots pinned yet</b>When someone says where their take is about, it shows up here. <a href="' + esc(opts.addHref || ("/" + city.slug + "/add/")) + '">Add a take</a></div>';

    return '<section class="guide" id="tv-guide" aria-labelledby="guide-h">' +
      '<div class="eats-h"><h2 id="guide-h">Guide to ' + esc(city.name) + "</h2></div>" +
      (sub.length ? '<p class="g-sub">' + esc(sub.join(" · ")) + "</p>" : "") +
      map +
      '<h3 class="g-h">Top restaurants</h3>' + eatList +
      '<h3 class="g-h">Spots in the takes</h3>' + spotList +
      (pts.length ? '<div class="eats-attrib">Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Places from <a href="https://overturemaps.org/" target="_blank" rel="noopener">Overture Maps</a>.</div>' : "") +
      (opts.stayHtml || "") +
      "</section>";
  }

  /* ---------- the map (browser only) ---------- */
  var loading = null;
  function loadLeaflet() {
    if (root.L && root.L.map) return Promise.resolve(root.L);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var doc = root.document, done = false;
      var t = setTimeout(function () { if (!done) { done = true; loading = null; reject(new Error("map timeout")); } }, MAP_TIMEOUT_MS);
      if (!doc.querySelector('link[href="' + MAP_CSS + '"]')) {
        var l = doc.createElement("link"); l.rel = "stylesheet"; l.href = MAP_CSS; doc.head.appendChild(l);
      }
      var s = doc.createElement("script"); s.src = MAP_JS; s.async = true;
      s.onload = function () { if (done) return; done = true; clearTimeout(t); root.L ? resolve(root.L) : reject(new Error("no L")); };
      s.onerror = function () { if (done) return; done = true; clearTimeout(t); loading = null; reject(new Error("map script failed")); };
      doc.head.appendChild(s);
    });
    return loading;
  }

  function popup(p) {
    var h = "<b>" + esc(p.name) + "</b><br>" + esc(p.sub);
    if (p.take) h += '<br><a href="/t/' + esc(p.take.id) + '">' + esc(p.take.title) + "</a>";
    return h;
  }

  function mountMap(rootEl) {
    var el = (rootEl || root.document).querySelector("[data-guide-map]:not([data-loaded])");
    if (!el || !el.offsetParent) return Promise.resolve(false);   // hidden tab: wait until it's shown
    el.dataset.loaded = "1";
    var pts = [];
    try { pts = JSON.parse(el.dataset.points || "[]"); } catch (e) { pts = []; }
    if (!pts.length) return Promise.resolve(false);
    return loadLeaflet().then(function (L) {
      el.innerHTML = "";
      // On a phone one finger scrolls the page (a map that grabs the drag traps the scroll); pinch zooms.
      var touch = !!(L.Browser && L.Browser.mobile);
      var map = L.map(el, { scrollWheelZoom: false, dragging: !touch, tap: !touch, attributionControl: true });
      map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
      L.tileLayer(TILES, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
      var bounds = [], markers = [];
      // Restaurants drawn over spots, #1 on top.
      pts.forEach(function (p, i) {
        var icon = L.divIcon({ className: "", html: '<span class="g-pin ' + (p.k === "eat" ? "eat" : "spot") + '">' + (p.k === "eat" ? p.n : "") + "</span>", iconSize: [26, 26], iconAnchor: [13, 13] });
        var m = L.marker([p.lat, p.lng], { icon: icon, title: p.name, alt: p.name, keyboard: true, zIndexOffset: p.k === "eat" ? 1000 - p.n * 10 : 0 }).addTo(map).bindPopup(popup(p));
        markers.push(m); bounds.push([p.lat, p.lng]);
      });
      // Pins that land on top of each other at this zoom (three places on one square) fan out around the spot.
      function declutter() {
        var placed = [];
        markers.forEach(function (m) {
          var pin = m.getElement() && m.getElement().firstChild; if (!pin) return;
          var at = map.latLngToContainerPoint(m.getLatLng()), dx = 0, dy = 0, k = 0;
          while (k < 12 && placed.some(function (q) { return Math.abs(q.x - (at.x + dx)) < 24 && Math.abs(q.y - (at.y + dy)) < 24; })) {
            var a = (k % 6) * Math.PI / 3 - Math.PI / 2, r = 22 * (1 + Math.floor(k / 6));
            dx = Math.round(r * Math.cos(a)); dy = Math.round(r * Math.sin(a)); k++;
          }
          pin.style.transform = dx || dy ? "translate(" + dx + "px," + dy + "px)" : "";
          placed.push({ x: at.x + dx, y: at.y + dy });
        });
      }
      if (bounds.length === 1) map.setView(bounds[0], 14); else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
      map.on("zoomend", declutter); declutter();
      el._map = map;
      return true;
    }).catch(function () {
      // A nice-to-have: the lists below still say everything the map does.
      el.dataset.failed = "1";
      el.innerHTML = '<div class="g-map-wait">The map didn\'t load. Everything on it is listed below.</div>';
      return false;
    });
  }

  root.TVGuide = { spots: spots, topEats: topEats, points: points, html: html, mountMap: mountMap, NOT_A_SPOT: NOT_A_SPOT, MAP_JS: MAP_JS, MAP_CSS: MAP_CSS, TILES: TILES };
})(typeof window !== "undefined" ? window : globalThis);
