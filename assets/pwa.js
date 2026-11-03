/* TripVibz as an app: registers the service worker (dist/sw.js) and, for people
   who keep coming back, offers "Add to home screen". Loaded deferred on every
   page by build.mjs. No framework, no cookies: a small localStorage note of
   how many visits and whether the offer was dismissed or taken. */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  var KEY = "tv.a2hs", DISMISS_DAYS = 30, MIN_VISITS = 2, SHOW_AFTER_MS = 3500;
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var ua = navigator.userAgent || "";
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var iosSafari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  function track(name, params) { try { if (window.gtag) window.gtag("event", name, params || {}); } catch (e) {} }
  function state() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  // 1. The service worker. After load, so it never competes with the page's own requests;
  //    updateViaCache "none" so a new deploy's sw.js is always fetched fresh.
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(function (reg) {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") reg.update().catch(function () {});
      });
    }).catch(function () {});
  });

  // 2. Opened from the home screen: note it, and never nag.
  var s = state();
  if (standalone) {
    if (!s.installed) { s.installed = true; save(s); }
    try { if (!sessionStorage.getItem("tv.pwaOpen")) { sessionStorage.setItem("tv.pwaOpen", "1"); track("pwa_open"); } } catch (e) {}
    return;
  }

  // 3. The offer. Only on browsing pages (not mid-task on add/vote/thread), only
  //    from the second visit, and not again for a month after "Not now".
  s.visits = (s.visits || 0) + 1; save(s);
  var path = location.pathname;
  var midTask = /^\/(admin|t\/)/.test(path) || /\/(add|vote)\/?$/.test(path);   // admin, a take's page, add, vote
  var browsing = !midTask;
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; schedule(); });
  window.addEventListener("appinstalled", function () { var t = state(); t.installed = true; save(t); hide(); track("pwa_installed"); });
  if (iosSafari) schedule();

  function eligible() {
    var t = state();
    return browsing && !t.installed && (t.visits || 0) >= MIN_VISITS && !(t.dismissed && Date.now() - t.dismissed < DISMISS_DAYS * 864e5) && !document.querySelector(".a2hs");
  }
  var timer = null;
  function schedule() { if (timer || !eligible()) return; timer = setTimeout(show, SHOW_AFTER_MS); }
  function show() {
    if (!eligible()) return;
    var box = document.createElement("div");
    box.className = "a2hs";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Add TripVibz to your home screen");
    var share = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/></svg>';
    box.innerHTML =
      '<img src="/assets/brand/icon-192.png" width="44" height="44" alt="">' +
      '<div class="a2hs-t"><b>Add TripVibz to your home screen</b>' +
        (deferred ? '<small>Opens like an app. No store, nothing to download.</small>'
                  : '<small>Tap ' + share + ' <b>Share</b>, then <b>Add to Home Screen</b>.</small>') +
      "</div>" +
      (deferred ? '<button type="button" class="a2hs-add">Add</button>' : "") +
      '<button type="button" class="a2hs-x" aria-label="Not now">&times;</button>';
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add("in"); });
    track("pwa_prompt_shown", { kind: deferred ? "android" : "ios" });
    var add = box.querySelector(".a2hs-add");
    if (add) add.addEventListener("click", function () {
      var p = deferred; deferred = null;
      if (!p) { hide(); return; }
      p.prompt();
      p.userChoice.then(function (r) { track("pwa_prompt_choice", { outcome: r && r.outcome }); if (!r || r.outcome !== "accepted") dismiss(); else hide(); }).catch(hide);
    });
    box.querySelector(".a2hs-x").addEventListener("click", function () { dismiss(); track("pwa_prompt_dismissed"); });
  }
  function dismiss() { var t = state(); t.dismissed = Date.now(); save(t); hide(); }
  function hide() { var b = document.querySelector(".a2hs"); if (b) { b.classList.remove("in"); setTimeout(function () { b.remove(); }, 250); } }
})();
