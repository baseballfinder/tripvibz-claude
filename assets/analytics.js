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
  // gtag() is defined now so events fired before the tag loads queue in the
  // dataLayer; the tag itself (177 KB) and Clarity load after the page is
  // interactive — on a phone they were blocking the main thread for ~660 ms
  // during load (PageSpeed, Oct 2026) without changing what gets measured.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA4_ID);

  function loadTrackers() {
    var ga = document.createElement("script");
    ga.async = true;
    ga.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(ga);

    /* ---- Microsoft Clarity ---- */
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
  }
  function whenIdle() {
    if (window.requestIdleCallback) window.requestIdleCallback(loadTrackers, { timeout: 4000 });
    else setTimeout(loadTrackers, 1500);
  }
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle);
})();
