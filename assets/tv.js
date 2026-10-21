/* ==========================================================================
   TripVibz — shared client
   Supabase bootstrap, formatting helpers, toast, and the anonymous→OAuth
   auth flow that every page shares. Exposed as window.TV.
   Load AFTER the supabase-js CDN script and BEFORE the page script.
   ========================================================================== */
(function () {
  "use strict";

  var SUPABASE_URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
  var SUPABASE_KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var $ = function (s) { return document.querySelector(s); };

  var TYPE_LABEL = {
    what_not_to_do: "What not to do",
    worst_times: "Worst times",
    hidden_gem: "Do this",
    take: "It depends",
    question: "Question",
    review: "Review",
    guide: "Guide",
    take: "Take"
  };

  var CHEVRON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 10l4.5-4.5L12.5 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var GOOGLE_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
  var FACEBOOK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.02 4.39 11.01 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.08 24 18.09 24 12.07z"/></svg>';

  /* ---------- routing ----------
     Pre-rendered pages live at real paths (/key-west/what-not-to-do/), not
     query strings, because Google treats ?a=1 variants of one static file as
     a single document. Every link in the app goes through routes() so the
     static build and the client agree on URLs. */

  var THEME_SLUG = {
    what_not_to_do: "what-not-to-do",
    worst_times: "worst-times-to-visit",
    hidden_gem: "what-locals-do"
  };
  var SLUG_THEME = {};
  Object.keys(THEME_SLUG).forEach(function (k) { SLUG_THEME[THEME_SLUG[k]] = k; });

  var routes = {
    home:    function () { return "/"; },
    cities:  function () { return "/cities/"; },
    city:    function (slug) { return "/" + encodeURIComponent(slug) + "/"; },
    article: function (slug, theme, add) {
      return "/" + encodeURIComponent(slug) + "/" + (THEME_SLUG[theme] || theme) + "/" +
             (add ? "?add=1" : "");
    },
    place:   function (id) { return "/place.html?id=" + encodeURIComponent(id); },
    thread:  function (id) { return "/t/" + encodeURIComponent(id); }
  };

  // Reads /{city}/{theme}/ from the path, falling back to query params so the
  // pages still work when opened directly during local development.
  function parseRoute() {
    var parts = location.pathname.split("/").filter(Boolean);
    var qs = new URLSearchParams(location.search);
    var out = { city: qs.get("city") || null, theme: null };

    if (parts.length >= 1 && parts[0] !== "cities" && !/\.html$/.test(parts[0])) {
      out.city = parts[0];
      if (parts.length >= 2 && SLUG_THEME[parts[1]]) out.theme = SLUG_THEME[parts[1]];
    }
    if (!out.theme) {
      var t = qs.get("theme");
      out.theme = SLUG_THEME[t] || (THEME_SLUG[t] ? t : null);
    }
    if (!out.city) out.city = qs.get("slug");
    return out;
  }

  /* ---------- formatting helpers ---------- */

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function timeAgo(iso) {
    var d = (Date.now() - new Date(iso)) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  }

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(msg) {
    var el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 1800);
  }

  /* ---------- login modal (injected so pages don't duplicate markup) ---------- */

  /* Sign-in options. Google is live. Each other one turns on once its setup is
     done (see README → "Sign-in providers"); until then ?preview=signin shows
     the buttons for review. Instagram has no sign-in for websites: people with
     Instagram sign in with the Facebook (Meta) account it's linked to. */
  var SIGNIN = { facebook: false, tiktok: false };
  var SIGNIN_PREVIEW = /[?&]preview=signin\b/.test(location.search);
  var FACEBOOK_LOGIN = SIGNIN.facebook || SIGNIN_PREVIEW;
  var TIKTOK_LOGIN = SIGNIN.tiktok || SIGNIN_PREVIEW;
  var TIKTOK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M16.6 5.82A4.3 4.3 0 0 1 15.54 3h-3.09v12.4a2.6 2.6 0 0 1-2.6 2.5 2.6 2.6 0 0 1-2.6-2.6 2.6 2.6 0 0 1 3.37-2.48V9.66a5.73 5.73 0 0 0-.77-.05A5.68 5.68 0 0 0 4.17 15.3 5.68 5.68 0 0 0 9.85 21a5.68 5.68 0 0 0 5.68-5.69V9.01a7.33 7.33 0 0 0 4.3 1.38V7.3a4.3 4.3 0 0 1-3.23-1.48z"/></svg>';

  /* Google Identity Services ("Sign in with Google" button).
     The redirect flow sends people through nkxorlktzbgwqnfwmuus.supabase.co,
     so Google's account chooser says "continue to …supabase.co". The GIS
     button runs on our own origin, so Google shows tripvibz.com instead, and
     the ID token is handed to Supabase with signInWithIdToken. Free; the
     alternative (Supabase custom domain) needs a paid plan.
     Requires: these origins listed under "Authorized JavaScript origins" on
     the Google OAuth client. Anywhere else (previews, localhost) falls back
     to the redirect flow. */
  var GOOGLE_CLIENT_ID = "348430375161-cghpf3tlg93qhlm62pc6lmtap4d1b0lb.apps.googleusercontent.com"; // TripVibz client; must also be listed in Supabase → Auth → Google → Client IDs
  var GIS_ORIGINS = ["https://www.tripvibz.com", "https://tripvibz.com", "https://tripvibz.pages.dev"];
  var gisReady = null;

  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      if (GIS_ORIGINS.indexOf(location.origin) < 0) return reject(new Error("origin not enabled for GIS"));
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () { window.google && google.accounts ? resolve() : reject(new Error("gis missing")); };
      s.onerror = function () { reject(new Error("gis failed to load")); };
      document.head.appendChild(s);
      setTimeout(function () { reject(new Error("gis timeout")); }, 6000);
    });
    return gisReady;
  }

  async function sha256hex(str) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function mountGoogleButton(host, fallbackBtn) {
    try {
      await loadGis();
      var raw = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        nonce: await sha256hex(raw),
        use_fedcm_for_prompt: true,
        callback: async function (resp) {
          var out = await sb.auth.signInWithIdToken({ provider: "google", token: resp.credential, nonce: raw });
          if (out.error) {
            console.error(out.error);
            toast("Sign-in didn't go through — try the other button");
            fallbackBtn.hidden = false;
            return;
          }
          // Reload so every page runs its normal signed-in path, including
          // posting a take that was saved before sign-in.
          location.reload();
        }
      });
      host.innerHTML = "";
      google.accounts.id.renderButton(host, {
        theme: "outline", size: "large", shape: "pill", text: "continue_with",
        logo_alignment: "center", width: Math.min(host.clientWidth || 300, 400)
      });
      host.hidden = false;
      fallbackBtn.hidden = true;
      var alt = host.parentNode.querySelector("[data-login-alt]");
      if (alt) alt.hidden = false;
    } catch (e) {
      // Not enabled here or blocked: the redirect button still works.
      host.hidden = true;
      fallbackBtn.hidden = false;
    }
  }

  function mountLoginModal() {
    if ($("#loginmodal")) return;
    var wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.id = "loginmodal";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="modal-card">' +
      '<h3 data-login-title>Join TripVibz</h3>' +
      '<p data-login-text>Save your cosigns, post takes, and review places.</p>' +
      '<div class="gsi-host" data-gsi hidden></div>' +
      '<button class="oauth google" data-provider="google">' + GOOGLE_SVG + "Continue with Google</button>" +
      '<button class="modal-alt" data-login-alt hidden>Trouble signing in? Use the other way</button>' +
      // Facebook login is off until Meta app review is done; an unapproved
      // app fails for everyone who isn't a listed tester.
      (FACEBOOK_LOGIN ? '<button class="oauth facebook" data-provider="facebook">' + FACEBOOK_SVG + "Continue with Facebook</button>" +
        '<div class="modal-note">On Instagram? Use the Facebook account it\'s linked to.</div>' : "") +
      (TIKTOK_LOGIN ? '<button class="oauth tiktok" data-tiktok>' + TIKTOK_SVG + "Continue with TikTok</button>" : "") +
      '<button class="modal-close" data-modal-close>Maybe later</button>' +
      '<div class="modal-fine">We only use your name and photo to set up your profile. You can keep browsing and voting without an account.</div>' +
      "</div>";
    document.body.appendChild(wrap);

    wrap.querySelectorAll(".oauth[data-provider]").forEach(function (b) {
      b.addEventListener("click", function () { auth.login(b.dataset.provider); });
    });
    var tt = wrap.querySelector("[data-tiktok]");
    if (tt) tt.addEventListener("click", function () {
      location.href = "/api/auth/tiktok/start?next=" + encodeURIComponent(location.pathname + location.search);
    });
    wrap.querySelector("[data-modal-close]").addEventListener("click", closeLogin);
    var redirectBtn = wrap.querySelector(".oauth.google");
    var alt = wrap.querySelector("[data-login-alt]");
    alt.addEventListener("click", function () { alt.hidden = true; redirectBtn.hidden = false; });
    mountGoogleButton(wrap.querySelector("[data-gsi]"), redirectBtn);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeLogin(); });
  }

  // openLogin({ pending: true }) when the visitor has already written a take:
  // tell them it's saved and what signing in does, not a generic "join" pitch.
  function openLogin(opts) {
    mountLoginModal();
    var m = $("#loginmodal");
    var pending = !!(opts && opts.pending);
    m.querySelector("[data-login-title]").textContent = pending ? "Almost there" : "Join TripVibz";
    m.querySelector("[data-login-text]").textContent = pending
      ? "Your take is saved. Sign in and we'll post it right away."
      : "Save your cosigns, post takes, and review places.";
    m.hidden = false;
  }
  function closeLogin() { var m = $("#loginmodal"); if (m) m.hidden = true; }

  // Back from /api/auth/tiktok/callback: exchange the one-time token in the
  // URL hash for a session, then tidy the address bar.
  var SIGNIN_MSG = { tiktok_off: "TikTok sign-in isn't switched on yet.",
    tiktok_failed: "TikTok sign-in didn't work. Try again, or use Google.", tiktok_cancelled: "" };
  async function finishTikTok() {
    var m = location.hash.match(/(?:^#|&)tt=([^&]+)/);
    var flag = (location.search.match(/[?&]signin=([\w]+)/) || [])[1];
    if (!m && !flag) return;
    var clean = location.pathname + location.search.replace(/([?&])signin=[\w]+&?/, "$1").replace(/[?&]$/, "");
    history.replaceState(null, "", clean);
    if (flag && SIGNIN_MSG[flag]) setTimeout(function () { toast(SIGNIN_MSG[flag]); }, 400);
    if (!m) return;
    var out = await sb.auth.verifyOtp({ token_hash: decodeURIComponent(m[1]), type: "magiclink" });
    if (out.error) { console.error(out.error); setTimeout(function () { toast(SIGNIN_MSG.tiktok_failed); }, 400); }
  }

  /* ---------- auth ----------
     Pages can set:
       TV.auth.onRender  — after the nav chip re-renders
       TV.auth.onSignOut — after sign-out drops back to an anonymous session
  */

  var auth = {
    me: null,
    canPersist: false,
    onRender: null,
    onSignOut: null,

    async ensure() {
      try {
        await finishTikTok();
        var res = await sb.auth.getSession();
        var session = res.data.session;
        if (session) {
          this.me = session.user;
          this.canPersist = true;
        } else {
          var out = await sb.auth.signInAnonymously();
          if (out.error) {
            this.canPersist = false;
            this.showAuthbar();
            this.renderUI();
            return;
          }
          this.me = out.data.user;
          this.canPersist = true;
        }
        if (this.me && !this.me.is_anonymous) await this.syncProfile();
        this.renderUI();
      } catch (e) {
        console.error(e);
        this.canPersist = false;
        this.showAuthbar();
        this.renderUI();
      }
    },

    showAuthbar() {
      var bar = $("#authbar");
      if (bar) bar.hidden = false;
    },

    // Copy name + photo from the social identity into the profile row.
    async syncProfile() {
      if (!this.me) return;
      var m = this.me.user_metadata || {};
      var display = m.full_name || m.name || (this.me.email ? this.me.email.split("@")[0] : null);
      var avatar = m.avatar_url || m.picture || null;
      if (!display && !avatar) return;
      try {
        await sb.from("profiles").update({ display_name: display, avatar_url: avatar }).eq("id", this.me.id);
      } catch (e) {
        console.error(e);
      }
    },

    renderUI() {
      var slot = $("#auth-slot");
      if (slot) {
        if (this.me && !this.me.is_anonymous) {
          var m = this.me.user_metadata || {};
          var name = m.full_name || m.name || (this.me.email ? this.me.email.split("@")[0] : "You");
          var av = m.avatar_url || m.picture || "";
          slot.innerHTML =
            '<div class="userchip"><img alt="" src="' + av + '" onerror="this.style.visibility=\'hidden\'">' +
            "<span>" + escapeHtml(name.split(" ")[0]) + "</span>" +
            '<button data-signout title="Sign out" aria-label="Sign out">⎋</button></div>';
          slot.querySelector("[data-signout]").addEventListener("click", this.signOut.bind(this));
          var bar = $("#authbar");
          if (bar) bar.hidden = true;
        } else {
          slot.innerHTML = '<button class="btn" data-login>Log in</button>';
          slot.querySelector("[data-login]").addEventListener("click", openLogin);
        }
      }
      if (typeof this.onRender === "function") this.onRender();
    },

    async login(provider) {
      var redirectTo = location.href.split("#")[0];
      try {
        var res = await sb.auth.getSession();
        var session = res.data.session;
        // Prefer linking (carries anonymous votes over), but fall back to a
        // normal social sign-in if "Manual linking" isn't enabled on the project.
        if (session && session.user.is_anonymous) {
          var linked = await sb.auth.linkIdentity({ provider: provider, options: { redirectTo: redirectTo } });
          if (linked.error) {
            var fb = await sb.auth.signInWithOAuth({ provider: provider, options: { redirectTo: redirectTo } });
            if (fb.error) throw fb.error;
          }
        } else {
          var direct = await sb.auth.signInWithOAuth({ provider: provider, options: { redirectTo: redirectTo } });
          if (direct.error) throw direct.error;
        }
      } catch (e) {
        console.error(e);
        toast("Couldn't start sign-in — check provider setup");
      }
    },

    async signOut() {
      try { await sb.auth.signOut(); } catch (e) { console.error(e); }
      this.me = null;
      this.canPersist = false;
      await this.ensure(); // drop back to anonymous so voting still works
      if (typeof this.onSignOut === "function") await this.onSignOut();
    }
  };

  /* ---------- votes ----------
     The DB half of voting, shared by any page that renders vote buttons.
     Optimistic UI stays with the page; this just persists (or clears) the row.
     Returns true when the write landed, false when it was skipped or failed. */

  async function persistVote(postId, value) {
    if (!auth.canPersist || !auth.me) return false;
    try {
      if (value === 0) {
        await sb.from("votes").delete().eq("user_id", auth.me.id).eq("post_id", postId);
      } else {
        await sb.from("votes").upsert(
          { user_id: auth.me.id, post_id: postId, value: value },
          { onConflict: "user_id,post_id" }
        );
      }
      return true;
    } catch (e) {
      console.error(e);
      toast("That vote didn't save");
      return false;
    }
  }

  /* ---------- moderation ----------
     The DB rejects slurs, sexual content and threats via trigger. The term
     list deliberately never reaches the browser, so we only translate the
     error code the database hands back. */

  var MODERATION_COPY = {
    SEXUAL: "That reads as sexually explicit, so it wasn't posted. Criticism of a place is fine \u2014 keep it about the place.",
    SLUR:   "That contains language we don't publish, so it wasn't posted. Say what went wrong instead.",
    THREAT: "That reads as a threat, so it wasn't posted. Be blunt about the place, not about people."
  };

  // Returns friendly copy for a moderation rejection, or null for other errors.
  function moderationMessage(err) {
    var msg = (err && (err.message || err.error_description || "")) || "";
    var m = /MODERATION_BLOCKED_([A-Z]+)/.exec(msg);
    if (!m) return null;
    return MODERATION_COPY[m[1]] || "That submission was rejected by our content policy.";
  }

  /* ---------- submitting a take ----------
     Routes through the /api/take Pages Function so Cloudflare can stamp a
     coarse locality signal the browser can't forge. The Function inserts as
     the signed-in user, so RLS and the moderation trigger apply unchanged.

     Falls back to a direct insert when the Function isn't there (local dev,
     or a static preview). The take still posts — it just carries no locality
     signal, which is fine because the signal never gates anything. */

  // --- tidy:start --- Light auto-correct for what people type: capital letters,
  // apostrophes (dont -> don't, im -> I'm), stray spaces, common misspellings,
  // a period at the end. Never rewrites meaning. Unit-tested in tests/static.mjs.
  var TIDY_WORDS = {
    dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't", isnt: "isn't",
    arent: "aren't", wasnt: "wasn't", werent: "weren't", shouldnt: "shouldn't", wouldnt: "wouldn't",
    couldnt: "couldn't", havent: "haven't", hasnt: "hasn't", thats: "that's", theres: "there's",
    whats: "what's", youre: "you're", theyre: "they're", im: "I'm", ive: "I've", youll: "you'll",
    alot: "a lot", definately: "definitely", definatly: "definitely", recieve: "receive", seperate: "separate",
    untill: "until", tommorow: "tomorrow", tomorow: "tomorrow", wierd: "weird", beleive: "believe",
    occured: "occurred", accomodation: "accommodation", accomodations: "accommodations",
    restaraunt: "restaurant", resturant: "restaurant", restraunt: "restaurant", restaraunts: "restaurants", resturants: "restaurants",
    beatiful: "beautiful", beautifull: "beautiful", neccessary: "necessary", necessary: "necessary",
    truely: "truly", basicly: "basically", experiance: "experience", reccomend: "recommend",
    recomend: "recommend", reccommend: "recommend", absolutly: "absolutely", probaly: "probably",
    tourits: "tourists", turists: "tourists", vaction: "vacation", vacaction: "vacation"
  };
  function tidyText(s) {
    if (!s) return s;
    s = String(s).replace(/\s+/g, " ").trim();
    s = s.replace(/\s+([,.!?;:])/g, "$1")                  // "word ," -> "word,"
         .replace(/([a-z]),(?=[a-z])/gi, "$1, ")            // "this,that" -> "this, that"
         .replace(/([!?])\1+/g, "$1")                       // "!!!" -> "!"
         .replace(/\b[a-z']+\b/gi, function (w) {
           var k = w.toLowerCase().replace(/'/g, "");
           if (w === "i") return "I";
           if (/^i'(m|ve|ll|d)$/i.test(w)) return "I'" + w.slice(2).toLowerCase();
           var fix = w.indexOf("'") < 0 && TIDY_WORDS[k];
           if (!fix) return w;
           return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
         });
    s = s.replace(/(^|[.!?]\s+)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    if (/[a-z0-9)"”]$/i.test(s)) s += ".";
    return s;
  }
  // --- tidy:end ---

  async function submitTake(fields) {
    var payload = {
      title: tidyText(fields.title),
      body: fields.body ? tidyText(fields.body) : null,
      type: fields.type,
      city_id: fields.city_id,
      city_name: fields.city_name || null,
      place_id: fields.place_id || null,
      place_label: fields.place_label || null,
      months: fields.months && fields.months.length ? fields.months : null
    };
    if (fields.topic) payload.topic = tidyText(fields.topic).replace(/\.$/, "");
    if (fields.question_id) payload.question_id = fields.question_id;
    try { return await sendTake(payload); }
    catch (e) {
      // Database not migrated yet (no topic / question_id columns): answers still post.
      if (!payload.topic && payload.question_id && /question_id/.test(String(e && (e.message || e.details)))) {
        delete payload.question_id;
        return await sendTake(payload);
      }
      throw e;
    }
  }

  async function sendTake(payload) {
    var token = null;
    try {
      var sess = await sb.auth.getSession();
      token = sess.data.session && sess.data.session.access_token;
    } catch (e) { /* fall through to direct insert */ }

    if (token) {
      var res = null;
      try {
        res = await fetch("/api/take", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (e) { res = null; }   // offline or no Function — fall back

      if (res && res.ok) {
        var out = await res.json();
        return { row: out.row, locality: out.locality || null };
      }
      // A real database rejection (moderation, RLS) must surface, not fall
      // back into a second attempt that would fail the same way.
      if (res && res.status !== 404) {
        var err = await res.json().catch(function () { return null; });
        if (err && err.detail) throw new Error(err.detail);
      }
    }

    var ins = await sb.from("posts").insert({
      title: payload.title,
      body: payload.body,
      type: payload.type,
      city_id: payload.city_id,
      place_id: payload.place_id,
      place_label: payload.place_label,
      months: payload.months,
      topic: payload.topic,
      question_id: payload.question_id,
      author_id: auth.me && auth.me.id
    }).select("id,title,body,type,ups,downs,comment_count,created_at,author_id,author_verified,place_id,place_label,months,city_match").single();

    if (ins.error) throw ins.error;
    return { row: ins.data, locality: null };
  }

  /* ---------- identity ----------
     Anonymous sessions can read and vote, but contributing an article needs a
     real identity, so pages gate their composer on this. */

  function isSignedIn() {
    return !!(auth.me && !auth.me.is_anonymous);
  }

  window.TV = { tidy: tidyText,
    sb: sb,
    persistVote: persistVote,
    routes: routes,
    parseRoute: parseRoute,
    THEME_SLUG: THEME_SLUG,
    SLUG_THEME: SLUG_THEME,
    submitTake: submitTake,
    moderationMessage: moderationMessage,
    isSignedIn: isSignedIn,
    $: $,
    TYPE_LABEL: TYPE_LABEL,
    CHEVRON: CHEVRON,
    escapeHtml: escapeHtml,
    timeAgo: timeAgo,
    toast: toast,
    auth: auth,
    openLogin: openLogin,
    closeLogin: closeLogin,
    mountLoginModal: mountLoginModal
  };
})();
