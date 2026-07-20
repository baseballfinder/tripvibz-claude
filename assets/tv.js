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
    hidden_gem: "Hidden gem",
    question: "Question",
    review: "Review",
    guide: "Guide",
    take: "Take"
  };

  var CHEVRON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 10l4.5-4.5L12.5 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var GOOGLE_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
  var FACEBOOK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.02 4.39 11.01 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.08 24 18.09 24 12.07z"/></svg>';

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

  function mountLoginModal() {
    if ($("#loginmodal")) return;
    var wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.id = "loginmodal";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="modal-card">' +
      "<h3>Join TripVibz</h3>" +
      "<p>Save your cosigns, post takes, and review places.</p>" +
      '<button class="oauth google" data-provider="google">' + GOOGLE_SVG + "Continue with Google</button>" +
      '<button class="oauth facebook" data-provider="facebook">' + FACEBOOK_SVG + "Continue with Facebook</button>" +
      '<button class="modal-close" data-modal-close>Maybe later</button>' +
      '<div class="modal-fine">We only use your name and photo to set up your profile. You can keep browsing and voting without an account.</div>' +
      "</div>";
    document.body.appendChild(wrap);

    wrap.querySelectorAll(".oauth[data-provider]").forEach(function (b) {
      b.addEventListener("click", function () { auth.login(b.dataset.provider); });
    });
    wrap.querySelector("[data-modal-close]").addEventListener("click", closeLogin);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeLogin(); });
  }

  function openLogin() { mountLoginModal(); $("#loginmodal").hidden = false; }
  function closeLogin() { var m = $("#loginmodal"); if (m) m.hidden = true; }

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

  async function submitTake(fields) {
    var payload = {
      title: fields.title,
      body: fields.body || null,
      type: fields.type,
      city_id: fields.city_id,
      city_name: fields.city_name || null,
      place_id: fields.place_id || null
    };

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
      author_id: auth.me && auth.me.id
    }).select("id,title,body,type,ups,downs,comment_count,created_at,author_id,place_id,city_match").single();

    if (ins.error) throw ins.error;
    return { row: ins.data, locality: null };
  }

  /* ---------- identity ----------
     Anonymous sessions can read and vote, but contributing an article needs a
     real identity, so pages gate their composer on this. */

  function isSignedIn() {
    return !!(auth.me && !auth.me.is_anonymous);
  }

  window.TV = {
    sb: sb,
    persistVote: persistVote,
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
