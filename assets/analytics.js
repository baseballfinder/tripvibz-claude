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

  /* ---- Google Analytics 4 ---- */
  var ga = document.createElement("script");
  ga.async = true;
  ga.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
  document.head.appendChild(ga);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA4_ID);

  /* ---- Microsoft Clarity ---- */
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, "clarity", "script", CLARITY_ID);
})();
