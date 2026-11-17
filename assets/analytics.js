/* ==========================================================================
   TripVibz — analytics
   The site's own log (visits, errors, failed saves) + Google Analytics 4 +
   Microsoft Clarity. Loaded from <head> on every page.
   Skipped on localhost / file:// so local work doesn't pollute reporting.
   ========================================================================== */
(function () {
  "use strict";

  var GA4_ID = "G-5R27XMC8LC";
  var CLARITY_ID = "xpi9uwoqof";

  var host = location.hostname;
  var isLocal =
    location.protocol === "file:" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    host.endsWith(".local");

  if (isLocal) {
    console.info("[analytics] skipped on " + (host || "file://"));
    return;
  }

  /* ---- site log → the admin page's live list and James's phone (functions/api/log.js) ----
     Four things are reported, each as one small beacon:
       page            every page opened; the first of a tab's visit also says where it came from
       leave           how long the page was open
       error           an error thrown by this site's own scripts (the function checks the stack)
       request_failed  a save, or a request to our API or database, that was refused or never answered
     No account, name or IP goes along: the visit id is a random string kept in
     this tab only. Capped per page view: 3 errors, 5 failed requests. */
  (function () {
    var LOG = "/api/log", SUPA = "nkxorlktzbgwqnfwmuus.supabase.co";
    // The admin page can switch the log off for the browser it is open in
    // ("Leave out this browser"), so the owner's own clicks stay out of it.
    try { if (localStorage.getItem("tv_nolog") === "1") return; } catch (e) { /* storage blocked */ }
    var realFetch = window.fetch, opened = Date.now(), leaving = false;
    var sid = "", first = false;
    try { sid = sessionStorage.getItem("tv_sid") || ""; } catch (e) { /* storage blocked */ }
    if (!/^[a-z0-9]{8,32}$/.test(sid)) {
      first = true;
      sid = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + "00000000").slice(0, 16);
      try { sessionStorage.setItem("tv_sid", sid); } catch (e) { /* each page then counts as its own visit */ }
    }
    function send(o) {
      try {
        o.sid = sid; o.path = location.pathname;
        var body = JSON.stringify(o);
        if (!(navigator.sendBeacon && navigator.sendBeacon("/api/log", new Blob([body], { type: "application/json" }))) && realFetch)
          realFetch.call(window, "/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
      } catch (e) { /* the log never breaks the page */ }
    }

    // The page view. utm tags (our emails and posts carry them) say which link brought the visit.
    var page = { k: "page" };
    if (first) {
      page.first = true;
      page.ref = String(document.referrer || "").slice(0, 300);
      try {
        var qs = new URLSearchParams(location.search || "");
        page.tag = [qs.get("utm_source"), qs.get("utm_campaign")].filter(Boolean).join(" / ").slice(0, 60);
      } catch (e) { /* no tags */ }
    }
    send(page);
    window.addEventListener("pagehide", function () {
      if (leaving) return;
      leaving = true;
      send({ k: "leave", ms: Date.now() - opened });
    });

    // Errors: each message once.
    var sent = {}, n = 0;
    function report(message, source, stack) {
      message = String(message || "").slice(0, 300);
      if (!message || sent[message] || n >= 3) return;
      sent[message] = true; n++;
      send({ k: "error", msg: message, src: String(source || "").slice(0, 200), stack: String(stack || "").slice(0, 600) });
    }
    window.addEventListener("error", function (e) {
      var src = e.filename ? e.filename + ":" + e.lineno : "";
      report(e.message, src, e.error && e.error.stack);
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason || {};
      report(r.message || String(r), "", r.stack);
    });

    // Failed saves and requests. Only our own API and database are watched, and
    // only the table or endpoint name is reported, never what was being saved.
    function target(url) {
      try {
        var u = new URL(url, location.href), m;
        if (u.hostname === SUPA) {
          if ((m = u.pathname.match(/^\/rest\/v1\/(rpc\/)?(\w+)/))) return (m[1] || "") + m[2];
          if ((m = u.pathname.match(/^\/auth\/v1\/(\w+)/))) return "auth/" + m[1];
          return null;
        }
        if (u.hostname === host && /^\/api\/[\w/.-]+$/.test(u.pathname) && u.pathname !== LOG) return u.pathname;
      } catch (e) { /* not an address */ }
      return null;
    }
    var fails = 0;
    function failed(what, status, msg) {
      if (fails >= 5 || leaving) return;
      fails++;
      send({ k: "request_failed", target: what, status: status, msg: String(msg || "").slice(0, 200) });
    }
    if (realFetch) window.fetch = function (input, init) {
      var p = realFetch.apply(this, arguments);
      try {
        var t = target(typeof input === "string" ? input : (input && input.url) || String(input));
        if (t) {
          var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
          var read = method === "GET" || method === "HEAD";
          p.then(function (res) {
            // A refused save (4xx) matters; a read that finds nothing (4xx) is normal. 5xx always matters.
            if (res.status < (read ? 500 : 400)) return;
            var body;
            try { body = res.clone().text(); } catch (e) { failed(method + " " + t, res.status, ""); return; }
            body.then(function (b) {
              var msg = "";
              try { var j = JSON.parse(b); msg = j.message || j.error || j.msg || j.code || ""; } catch (e) { /* not JSON */ }
              failed(method + " " + t, res.status, msg);
            }, function () { failed(method + " " + t, res.status, ""); });
          }, function (err) {
            // Leaving the page cancels what was in flight; that isn't a failure.
            if (err && err.name === "AbortError") return;
            if (document.visibilityState === "hidden") return;
            failed(method + " " + t, 0, err && err.message);
          });
        }
      } catch (e) { /* watching never changes the request */ }
      return p;
    };
  })();

  /* ---- Google Analytics 4 ---- */
  // gtag() is defined now, so the page view and any event fired before the
  // tag loads wait in the dataLayer and are sent when it does.
  //
  // The tag itself (177 KB) and Clarity are held back until the visitor first
  // touches, scrolls or types, or WAIT_MS after the page has loaded, whichever
  // comes first. Loaded straight after "load" (Oct 2026) they still ran on a
  // phone while the page was settling: two Google tag tasks of 190 + 273 ms
  // and an 82 ms Clarity task (PageSpeed, a city page, Nov 12 2026), which was
  // nearly all of the page's blocking time. Clarity follows the Google tag by
  // GAP_MS so the two never run back to back.
  // Trade-off: a visit that ends within WAIT_MS of loading with no touch,
  // scroll or key press is not counted.
  var WAIT_MS = 5000, GAP_MS = 1500;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA4_ID);

  function loadGoogle() {
    var ga = document.createElement("script");
    ga.async = true;
    ga.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(ga);
  }
  function loadClarity() {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
  }

  var FIRST_USE = ["pointerdown", "touchstart", "keydown", "scroll", "wheel"];
  var started = false;
  function start() {
    if (started) return;
    started = true;
    FIRST_USE.forEach(function (t) { window.removeEventListener(t, start, true); });
    // Not inside the tap or key handler itself: let the page answer first.
    setTimeout(loadGoogle, 0);
    setTimeout(loadClarity, GAP_MS);
  }
  FIRST_USE.forEach(function (t) { window.addEventListener(t, start, { capture: true, passive: true }); });
  function afterLoad() { setTimeout(start, WAIT_MS); }
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad);
})();
