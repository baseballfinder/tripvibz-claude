/* ==========================================================================
   TripVibz — analytics
   Google Analytics 4 + Microsoft Clarity. Loaded from <head> on every page.
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

  /* ---- search visits → James's phone (functions/api/hit.js) ----
     Once per visit, only when the visit started from a search engine. */
  try {
    var ref = document.referrer || "", refHost = ref ? new URL(ref).hostname : "";
    if (refHost && refHost !== host && /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|search\.brave\.com|perplexity\.ai|chatgpt\.com)$/.test(refHost)
        && !sessionStorage.getItem("tv_search_hit")) {
      sessionStorage.setItem("tv_search_hit", "1");
      var body = JSON.stringify({ path: location.pathname, ref: ref });
      if (!(navigator.sendBeacon && navigator.sendBeacon("/api/hit", new Blob([body], { type: "application/json" }))))
        fetch("/api/hit", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
    }
  } catch (e) { /* never block analytics */ }

  /* ---- errors → James's phone (functions/api/error.js) ----
     Only errors from this site's own scripts are reported (the function
     checks the stack), at most 3 per page view, each message once. */
  (function () {
    var sent = {}, n = 0;
    function report(message, source, stack) {
      try {
        message = String(message || "").slice(0, 300);
        if (!message || sent[message] || n >= 3) return;
        sent[message] = true; n++;
        var body = JSON.stringify({ message: message, source: String(source || "").slice(0, 200), stack: String(stack || "").slice(0, 600), page: location.pathname });
        if (!(navigator.sendBeacon && navigator.sendBeacon("/api/error", new Blob([body], { type: "application/json" }))))
          fetch("/api/error", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
      } catch (e) { /* never throw from the error reporter */ }
    }
    window.addEventListener("error", function (e) {
      var src = e.filename ? e.filename + ":" + e.lineno : "";
      report(e.message, src, e.error && e.error.stack);
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason || {};
      report(r.message || String(r), "", r.stack);
    });
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
