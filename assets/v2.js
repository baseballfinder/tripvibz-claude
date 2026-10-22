/* ==========================================================================
   TripVibz feed v2 — shared data + rendering for the city feed, vote page,
   post page and thread. Load AFTER tv.js. Exposes window.TV2.
   ========================================================================== */
(function () {
  "use strict";
  var TV = window.TV;
  var sb = TV.sb, esc = TV.escapeHtml, auth = TV.auth;

  var KIND = {
    what_not_to_do: { label: "Don’t do this", sub: "A mistake visitors make",
      starters: function (c) { return ["Never ___ in " + c + ", because ___.", "Skip ___. Locals ___ instead.", "Visitors always ___. Don’t."]; } },
    worst_times: { label: "When to go", sub: "Best and worst times to come",
      starters: function (c) { return ["Avoid " + c + " in ___, because ___.", "___ is the worst week. Come ___ instead.", "Don’t go to ___ on ___."]; } },
    hidden_gem: { label: "Do this", sub: "What locals recommend",
      starters: function (c) { return ["Locals go to ___ for ___.", "Instead of ___, try ___.", "Nobody visiting knows about ___."]; } },
    // "It depends" answers to questions (Only on weekdays, Depends on the night…). Not offered on the add page.
    take: { label: "It depends", sub: "Worth it, with a catch", answerOnly: true,
      starters: function (c) { return ["Only if ___.", "Worth it, but ___.", "Go on ___, not ___."]; } }
  };

  // Which kind a question answer is, so its card says "Do this", "Don't do this",
  // "It depends" or "When to go" instead of always "Don't do this".
  var TIMING_Q = /^(best|worst) time|^when (should|to)|month|season/i;
  var DONT = /^(skip|avoid|stay away|bad idea|a mistake|not worth|over(priced|hyped|rated|blown|done)|tourist trap|too crowded|the worst part|just avoid|real problem|a tourist thing|neither|better (beaches|views)|go somewhere|go to (a different|another)|wait|just a photo|just look|once is enough|one block is enough|no, )/i;
  var DEPENDS = /^(only|depends|go on a weekday|weekdays only|weeknights only|mornings only|better in the daytime|just (one night|a day|for a day|the parade|walk|for)|plan around|do it once|fun once|worth seeing once|quick stop|part of a longer|go at sunrise|leave before|calle ocho only|once, then|rent one for|drive one way)/i;
  function answerKind(prompt, label) {
    if (TIMING_Q.test(prompt || "")) return "worst_times";
    if (DONT.test(label || "")) return "what_not_to_do";
    if (DEPENDS.test(label || "")) return "take";
    return "hidden_gem";
  }

  var TENURE = {
    "lt1": "Under 1 year", "1-5": "1–5 years", "5-10": "5–10 years", "10+": "10+ years",
    "grew_up": "Grew up here", "visitor": "I visit often"
  };
  function tenureBadge(t) {
    if (!t) return "Local";
    if (t === "visitor") return "Regular visitor";
    if (t === "grew_up") return "Local · grew up here";
    return "Local · " + ({ "lt1": "<1 yr", "1-5": "1–5 yrs", "5-10": "5–10 yrs", "10+": "10+ yrs" })[t];
  }

  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function monthsLabel(m) {
    if (!m || !m.length) return "";
    var s = m.slice().sort(function (a, b) { return a - b; });
    // collapse runs: Mar–May
    var out = [], i = 0;
    while (i < s.length) {
      var j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j - i >= 2 ? MON[s[i] - 1] + "–" + MON[s[j] - 1] : s.slice(i, j + 1).map(function (x) { return MON[x - 1]; }).join(" · "));
      i = j + 1;
    }
    return out.join(" · ");
  }

  function shortName(p) {
    var n = (p && (p.display_name || p.username)) || "";
    var parts = n.trim().split(/\s+/);
    if (!parts[0]) return "A local";
    return parts.length > 1 ? parts[0] + " " + parts[parts.length - 1][0] + "." : parts[0];
  }

  var ICON = {
    pin: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>'
  };

  /* ---------- data ---------- */

  async function loadCity(slug) {
    var r = await sb.from("cities").select("id,name,state,slug,lat,lng,photo").eq("slug", slug).maybeSingle();
    if (r.data) window.__tvCityName = r.data.name;
    return r.data || null;
  }

  // Everything the feed / thread needs about a set of posts.
  // extraAuthors: verified commenters on a thread, whose names and badges we also need.
  async function hydrate(posts, cityId, extraAuthors) {
    var ids = posts.map(function (p) { return p.id; });
    var authors = Array.from(new Set(posts.filter(function (p) { return p.author_verified && p.author_id; }).map(function (p) { return p.author_id; }).concat(extraAuthors || [])));
    var placeIds = Array.from(new Set(posts.map(function (p) { return p.place_id; }).filter(Boolean)));
    var res = await Promise.all([
      authors.length ? sb.from("profiles").select("id,display_name,username").in("id", authors) : { data: [] },
      authors.length && cityId ? sb.from("city_tenure").select("user_id,tenure").eq("city_id", cityId).in("user_id", authors) : { data: [] },
      cityId ? sb.from("city_founders").select("author_id,rank").eq("city_id", cityId) : { data: [] },
      placeIds.length ? sb.from("places").select("id,name").in("id", placeIds) : { data: [] },
      auth.me && ids.length ? sb.from("votes").select("post_id,value").eq("user_id", auth.me.id).in("post_id", ids) : { data: [] }
    ]);
    var ctx = { profiles: {}, tenure: {}, founders: {}, places: {}, myVotes: {} };
    (res[0].data || []).forEach(function (x) { ctx.profiles[x.id] = x; });
    (res[1].data || []).forEach(function (x) { ctx.tenure[x.user_id] = x.tenure; });
    (res[2].data || []).forEach(function (x) { ctx.founders[x.author_id] = x.rank; });
    (res[3].data || []).forEach(function (x) { ctx.places[x.id] = x.name; });
    (res[4].data || []).forEach(function (x) { ctx.myVotes[x.post_id] = x.value; });
    ctx.founderCount = Object.keys(ctx.founders).length;
    return ctx;
  }

  var POST_COLS = "id,title,body,type,ups,downs,comment_count,created_at,author_id,author_verified,place_id,place_label,months,city_id,status";
  var POST_COLS_X = POST_COLS + ",topic,question_id";

  // A city's takes. Asks for topic/question_id too, and quietly drops them if
  // the database hasn't been migrated yet, so the feed never comes up empty.
  async function loadPosts(cityId, types) {
    var q = function (cols) { var x = sb.from("posts").select(cols).eq("city_id", cityId); return types ? x.in("type", types) : x; };
    var r = await q(POST_COLS_X);
    if (r.error) r = await q(POST_COLS);
    return r.data || [];
  }

  function placeOf(p, ctx) { return p.place_label || (p.place_id && ctx.places[p.place_id]) || ""; }
  function isSplit(p) { var t = p.ups + p.downs; return t >= 10 && Math.min(p.ups, p.downs) / t >= 0.35; }

  // Ranking: net agreement, verified takes weighted double; "hot" decays with age.
  function score(p) { return (p.ups - p.downs) * (p.author_verified ? 2 : 1); }
  function hot(p) {
    var hrs = (Date.now() - new Date(p.created_at).getTime()) / 36e5;
    return (score(p) + 1) / Math.pow(hrs + 2, 1.5);
  }
  function sortPosts(list, mode) {
    var a = list.slice();
    if (mode === "new") a.sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); });
    else if (mode === "hot") a.sort(function (x, y) { return hot(y) - hot(x); });
    else a.sort(function (x, y) { return score(y) - score(x) || new Date(x.created_at) - new Date(y.created_at); });
    return a;
  }

  /* ---------- rendering ---------- */

  function ago(iso) { var t = TV.timeAgo(iso); return /now/.test(t) ? t : t + " ago"; }

  function authorHtml(p, ctx) {
    if (!p.author_verified || !p.author_id) {
      return '<b>Anonymous</b><span class="bdg unv">Unverified</span>';
    }
    var me = auth.me && p.author_id === auth.me.id;
    var name = me ? "You" : shortName(ctx.profiles[p.author_id]);
    var html = "<b>" + esc(name) + '</b><span class="bdg local">' + esc(tenureBadge(ctx.tenure[p.author_id])) + "</span>";
    if (ctx.founders[p.author_id]) html += '<span class="bdg found">Founding local</span>';
    return html;
  }

  function takeHtml(p, ctx, opts) {
    opts = opts || {};
    var v = ctx.myVotes[p.id] || 0;
    var pct = p.ups + p.downs ? Math.round(100 * p.ups / (p.ups + p.downs)) : 0;
    var place = placeOf(p, ctx), when = monthsLabel(p.months);
    var href = TV.routes.thread(p.id);
    return '<article class="take' + (p.status === "pending" ? " is-pending" : "") + '" data-id="' + p.id + '">' +
      '<div class="tags">' +
        (KIND[p.type] ? '<span class="tag2">' + esc(KIND[p.type].label) + "</span>" : "") +
        (place ? '<span class="tag2">' + ICON.pin + esc(place) + "</span>" : "") +
        (when ? '<span class="tag2">' + esc(when) + "</span>" : "") +
        (isSplit(p) ? '<span class="tag2 split">Locals are split</span>' : "") +
        (p.topic ? '<span class="tag2">On: ' + esc(p.topic) + "</span>" : "") +
        (p.status === "pending" ? '<span class="tag2 pending">Waiting for review · only you can see it</span>' : "") +
      "</div>" +
      (opts.noLink ? '<h1 class="tt" style="font-size:23px">' + esc(p.title) + "</h1>" : '<a class="tt" href="' + href + '">' + esc(p.title) + "</a>") +
      (p.body ? '<div class="more">' + esc(p.body) + "</div>" : "") +
      '<div class="who">' + authorHtml(p, ctx) + "<span>· " + ago(p.created_at) + "</span></div>" +
      (opts.noBar ? "" : '<div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
      '<div class="tv-actions">' +
        '<button class="tvb yes" data-vote="1" data-id="' + p.id + '" aria-pressed="' + (v === 1) + '">' + ICON.check + "True · " + p.ups + "</button>" +
        '<button class="tvb no" data-vote="-1" data-id="' + p.id + '" aria-pressed="' + (v === -1) + '">' + ICON.x + "Nope · " + p.downs + "</button>" +
        '<a class="replies-link" href="' + href + '">' + ICON.chat + p.comment_count + "</a>" +
        '<button class="tv-share" data-share-take="' + p.id + '" aria-label="Share this take">' + ICON.share + "</button>" +
      "</div>") +
    "</article>";
  }

  // Toggle a True/Nope vote on a post object in place, then persist.
  async function castVote(p, ctx, value) {
    var prev = ctx.myVotes[p.id] || 0;
    var next = prev === value ? 0 : value;
    if (prev === 1) p.ups--; else if (prev === -1) p.downs--;
    if (next === 1) p.ups++; else if (next === -1) p.downs++;
    ctx.myVotes[p.id] = next;
    await TV.persistVote(p.id, next);
  }

  /* ---------- questions ---------- */

  async function loadQuestions(cityId) {
    var q = await sb.from("questions").select("id,prompt,options,place_label,sort").eq("city_id", cityId).eq("active", true).order("sort");
    var qs = q.data || [];
    if (!qs.length) return [];
    var ids = qs.map(function (x) { return x.id; });
    var r = await Promise.all([
      sb.rpc("question_results", { qids: ids }),
      auth.me ? sb.from("question_votes").select("question_id,option_id").eq("user_id", auth.me.id).in("question_id", ids) : { data: [] }
    ]);
    var counts = {}, mine = {};
    (r[0].data || []).forEach(function (x) { (counts[x.question_id] = counts[x.question_id] || {})[x.option_id] = Number(x.n); });
    (r[1].data || []).forEach(function (x) { mine[x.question_id] = x.option_id; });
    qs.forEach(function (x) { x.counts = counts[x.id] || {}; x.mine = mine[x.id] || null; });
    return qs;
  }

  function qTotal(q) { return Object.keys(q.counts).reduce(function (s, k) { return s + q.counts[k]; }, 0); }

  async function answer(q, optionId) {
    if (!auth.me) await auth.ensure();
    var prev = q.mine;
    if (prev === optionId) return true;
    if (prev) q.counts[prev] = Math.max(0, (q.counts[prev] || 1) - 1);
    q.counts[optionId] = (q.counts[optionId] || 0) + 1;
    q.mine = optionId;
    var r = await sb.from("question_votes").upsert({ question_id: q.id, user_id: auth.me.id, option_id: optionId }, { onConflict: "question_id,user_id" });
    if (r.error) { console.error(r.error); TV.toast("That vote didn't save"); return false; }
    return true;
  }

  function qOptionsHtml(q, asLinks, base) {
    var total = qTotal(q), voted = !!q.mine;
    return q.options.map(function (o) {
      var n = q.counts[o.id] || 0, pct = total ? Math.round(100 * n / total) : 0, mine = q.mine === o.id;
      var inner = '<span class="fill" style="width:' + (voted ? pct : 0) + '%"></span>' +
        "<span>" + esc(o.label) + (mine ? '<span class="you">You</span>' : "") + "</span>" +
        (voted ? '<span style="font-family:Archivo;font-weight:800">' + pct + "%</span>" : "");
      return asLinks
        ? '<a class="qopt' + (mine ? " mine" : "") + '" href="' + base + "?q=" + q.id + "&a=" + encodeURIComponent(o.id) + '">' + inner + "</a>"
        : '<button class="qopt' + (mine ? " mine" : "") + '" data-opt="' + esc(o.id) + '" aria-pressed="' + mine + '">' + inner + "</button>";
    }).join("");
  }

  /* ---------- claim: move anonymous work to a Google account ---------- */

  var CLAIM_KEY = "tv_claim";
  async function prepareClaim() {
    if (!auth.me || !auth.me.is_anonymous) return;
    var r = await sb.rpc("create_claim");
    if (!r.error && r.data) { try { localStorage.setItem(CLAIM_KEY, r.data); } catch (e) {} }
  }
  async function finishClaim() {
    var t = null;
    try { t = localStorage.getItem(CLAIM_KEY); } catch (e) {}
    if (!t || !auth.me || auth.me.is_anonymous) return 0;
    var r = await sb.rpc("redeem_claim", { tok: t });
    try { localStorage.removeItem(CLAIM_KEY); } catch (e) {}
    if (r.error) { console.error(r.error); return 0; }
    return r.data || 0;
  }
  // Open the sign-in popup, keeping anonymous takes claimable.
  async function signInForBadge(opts) {
    await prepareClaim();
    TV.openLogin(opts || {});
  }

  async function saveTenure(cityId, tenure) {
    if (!auth.me || !tenure) return;
    await sb.from("city_tenure").upsert({ user_id: auth.me.id, city_id: cityId, tenure: tenure }, { onConflict: "user_id,city_id" });
  }

  /* ---------- share card (canvas → PNG) ---------- */

  function wrapLines(ctx2, text, maxW) {
    var words = text.split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      var t = line ? line + " " + w : w;
      if (ctx2.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }

  async function drawShareCard(canvas, d) {
    // 1080x1920 story; d = {city, text, place, badge, ups, downs, url}
    try { await document.fonts.load('900 64px "Archivo"'); } catch (e) {}
    var W = 1080, H = 1920, c = canvas.getContext("2d");
    canvas.width = W; canvas.height = H;
    c.fillStyle = "#16130e"; c.fillRect(0, 0, W, H);
    c.fillStyle = "#e8492a"; c.beginPath(); c.arc(110, 150, 16, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#fff"; c.font = '900 54px "Archivo", sans-serif'; c.fillText("TripVibz", 142, 168);
    c.fillStyle = "#ff9b80"; c.font = '800 36px "Archivo", sans-serif';
    c.fillText(("A " + d.city + " local says").toUpperCase(), 90, 420);
    c.fillStyle = "#fff"; c.font = '900 92px "Archivo", sans-serif';
    var lines = wrapLines(c, d.text, 900).slice(0, 8), y = 540;
    lines.forEach(function (l) { c.fillText(l, 90, y); y += 108; });
    y += 20;
    c.font = '700 36px "Public Sans", sans-serif';
    [d.place, d.badge].filter(Boolean).forEach(function (t) {
      var w = c.measureText(t).width + 56;
      c.fillStyle = "#2c2821"; roundRect(c, 90, y, w, 72, 36); c.fill();
      c.fillStyle = "#fff"; c.fillText(t, 118, y + 49); y += 92;
    });
    var tot = d.ups + d.downs;
    if (tot) {
      c.fillStyle = "#fff"; c.font = '700 38px "Public Sans", sans-serif';
      c.fillText(d.ups + " locals: true", 90, 1490);
      c.textAlign = "right"; c.fillText(d.downs + ": nope", 990, 1490); c.textAlign = "left";
      c.fillStyle = "#6d8fd6"; roundRect(c, 90, 1520, 900, 22, 11); c.fill();
      c.fillStyle = "#fff"; roundRect(c, 90, 1520, Math.max(22, 900 * d.ups / tot), 22, 11); c.fill();
    }
    c.fillStyle = "#fff"; roundRect(c, 90, 1600, 440, 130, 34); c.fill();
    c.fillStyle = "#e8492a"; roundRect(c, 550, 1600, 440, 130, 34); c.fill();
    c.fillStyle = "#16130e"; c.font = '800 52px "Archivo", sans-serif'; c.textAlign = "center";
    c.fillText("True", 310, 1682); c.fillText("Nope", 770, 1682);
    c.fillStyle = "#c9c2b4"; c.font = '600 36px "Public Sans", sans-serif';
    c.fillText(d.url.replace(/^https?:\/\//, ""), 540, 1820); c.textAlign = "left";
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  async function shareCard(canvas, d) {
    var blob = await new Promise(function (res) { canvas.toBlob(res, "image/png"); });
    var file = blob ? new File([blob], "tripvibz-take.png", { type: "image/png" }) : null;
    var text = "A " + d.city + " local says: “" + d.text + "” True or nope?";
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: text, url: d.url }); return "shared"; } catch (e) { return "cancelled"; }
    }
    if (navigator.share) { try { await navigator.share({ text: text, url: d.url }); return "shared"; } catch (e) { return "cancelled"; } }
    if (blob) { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tripvibz-take.png"; a.click(); return "downloaded"; }
    return "none";
  }

  /* ---------- sharing ---------- */

  var SITE = "https://www.tripvibz.com";
  function track(name, params) { try { if (window.gtag) window.gtag("event", name, params || {}); } catch (e) {} }

  function takeShare(p, cityName) {
    return {
      url: SITE + "/t/" + p.id,
      text: (cityName ? "A " + cityName + " local says: " : "A local says: ") + "\u201c" + p.title + "\u201d True or nope?",
      kind: "take", id: p.id
    };
  }
  function questionShare(q, city, pickedLabel) {
    return {
      url: SITE + "/" + city.slug + "/vote/?q=" + q.id,
      text: city.name + " locals, settle this: " + q.prompt + (pickedLabel ? " I said \u201c" + pickedLabel + ".\u201d You?" : ""),
      kind: "question", id: q.id
    };
  }

  // One tap on phones (the system share sheet: Messages, WhatsApp, Instagram, Facebook…);
  // a small menu on desktop, where there is no share sheet.
  async function share(d) {
    track("share_open", { kind: d.kind, id: d.id });
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try { await navigator.share({ text: d.text, url: d.url }); track("share_done", { kind: d.kind, method: "native" }); } catch (e) {}
      return;
    }
    shareSheet(d);
  }

  function shareLinks(d) {
    var u = encodeURIComponent(d.url), t = encodeURIComponent(d.text), both = encodeURIComponent(d.text + " " + d.url);
    return [
      ["copy", "Copy link", null],
      ["sms", "Text message", "sms:?&body=" + both],
      ["whatsapp", "WhatsApp", "https://wa.me/?text=" + both],
      ["facebook", "Facebook", "https://www.facebook.com/sharer/sharer.php?u=" + u],
      ["x", "X", "https://twitter.com/intent/tweet?text=" + t + "&url=" + u],
      ["email", "Email", "mailto:?subject=" + encodeURIComponent("True or nope?") + "&body=" + both]
    ];
  }

  function shareSheet(d) {
    var old = document.getElementById("sharesheet"); if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.id = "sharesheet"; wrap.className = "sheet-wrap";
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h">' +
      '<div class="sheet-h" id="sheet-h">Do your friends agree?</div>' +
      '<div class="sheet-q">' + esc(d.text) + "</div>" +
      '<div class="sheet-grid">' + shareLinks(d).map(function (l) {
        return l[2]
          ? '<a class="sheet-b" data-m="' + l[0] + '" href="' + l[2] + '" target="_blank" rel="noopener">' + l[1] + "</a>"
          : '<button class="sheet-b" data-m="' + l[0] + '">' + l[1] + "</button>";
      }).join("") + "</div>" +
      '<button class="sheet-x" aria-label="Close">Close</button></div>';
    document.body.appendChild(wrap);
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", async function (e) {
      if (e.target === wrap || e.target.closest(".sheet-x")) return close();
      var b = e.target.closest("[data-m]"); if (!b) return;
      track("share_done", { kind: d.kind, method: b.dataset.m });
      if (b.dataset.m === "copy") {
        e.preventDefault();
        try { await navigator.clipboard.writeText(d.text + " " + d.url); TV.toast("Link copied. Paste it anywhere."); }
        catch (err) { TV.toast(d.url); }
      }
      close();
    });
    var first = wrap.querySelector(".sheet-b"); if (first) first.focus();
  }

  // Any take card on any page: the share button finds its take and city.
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-share-take]"); if (!b) return;
    e.preventDefault();
    var card = b.closest(".take");
    var title = card ? (card.querySelector(".tt") || {}).textContent : "";
    share(takeShare({ id: b.dataset.shareTake, title: (title || "").trim() }, b.dataset.city || window.__tvCityName || ""));
  });

  /* ---------- "When to go" summary from the editors' calendar (city_events) ----------
     Month colour: avoid beats good, good beats busy. A one-off event (CES,
     Fantasy Fest) marks its month busy at most; only a season or weather can
     mark a whole month "avoid". Each line names the reason. */
  var WMON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var SEASONAL = { season: 1, weather: 1 };
  function wCovers(e, m) { return e.start_month <= e.end_month ? (m >= e.start_month && m <= e.end_month) : (m >= e.start_month || m <= e.end_month); }
  function wMonths(e) { var out = []; for (var m = 1; m <= 12; m++) if (wCovers(e, m)) out.push(m); return out; }
  function wSev(events, m) {
    var has = {};
    (events || []).forEach(function (e) { if (wCovers(e, m)) has[e.severity === "avoid" && !SEASONAL[e.kind] ? "busy" : e.severity] = 1; });
    return has.avoid ? "avoid" : has.good ? "good" : has.busy ? "busy" : null;
  }
  function wSpan(a, b) { return a === b ? WMON[a - 1] : WMON[a - 1] + "–" + WMON[b - 1]; }
  function wRuns(events, sev) {
    var ms = [], out = [], a = null, b = null;
    for (var m = 1; m <= 12; m++) if (wSev(events, m) === sev) ms.push(m);
    ms.forEach(function (m) { if (a && m === b + 1) b = m; else { if (a) out.push([a, b]); a = b = m; } });
    if (a) out.push([a, b]);
    // join a run ending in December with one starting in January (Nov–Feb)
    if (out.length > 1 && out[0][0] === 1 && out[out.length - 1][1] === 12) { var last = out.pop(); out[0] = [last[0], out[0][1]]; }
    return out;
  }
  function wInRun(run, m) { return run[0] <= run[1] ? (m >= run[0] && m <= run[1]) : (m >= run[0] || m <= run[1]); }
  // The entries behind a run of months: most overlap first, at most two names.
  function wWhy(events, run, pick) {
    return events.filter(pick).map(function (e) {
      return { e: e, n: wMonths(e).filter(function (m) { return wInRun(run, m); }).length };
    }).filter(function (x) { return x.n; }).sort(function (x, y) { return y.n - x.n; })
      .slice(0, 2).map(function (x) { return x.e.name; });
  }
  function wLine(cls, label, items) {
    return '<div class="wl"><i class="' + cls + '"></i><div><em>' + label + "</em>" + items.join("<br>") + "</div></div>";
  }
  function whenSummary(events) {
    events = events || [];
    var lines = [];
    var best = wRuns(events, "good").map(function (r) {
      var why = wWhy(events, r, function (e) { return e.severity === "good"; });
      return "<b>" + wSpan(r[0], r[1]) + "</b>" + (why.length ? " · " + esc(why.join(", ")) : "");
    });
    var worst = wRuns(events, "avoid").map(function (r) {
      var why = wWhy(events, r, function (e) { return e.severity === "avoid" && SEASONAL[e.kind]; });
      return "<b>" + wSpan(r[0], r[1]) + "</b>" + (why.length ? " · " + esc(why.join(", ")) : "");
    });
    // Big one-off events worth planning around: the ones the editors marked avoid first.
    var plan = events.filter(function (e) { return !SEASONAL[e.kind] && (e.severity === "avoid" || e.severity === "busy"); })
      .sort(function (x, y) { return (y.severity === "avoid") - (x.severity === "avoid") || x.start_month - y.start_month; })
      .slice(0, 3).sort(function (x, y) { return x.start_month - y.start_month; })
      .map(function (e) { return "<b>" + wSpan(e.start_month, e.end_month) + "</b> · " + esc(e.name); });
    // Busy seasons that are a draw in their own right (fall leaf season, summer peak).
    var peak = events.filter(function (e) { return e.kind === "season" && e.severity === "busy"; })
      .sort(function (x, y) { return wMonths(x).length - wMonths(y).length; }).slice(0, 2)
      .sort(function (x, y) { return x.start_month - y.start_month; })
      .map(function (e) { return "<b>" + wSpan(e.start_month, e.end_month) + "</b> · " + esc(e.name); });
    if (best.length) lines.push(wLine("good", "Best", best));
    if (worst.length) lines.push(wLine("avoid", "Avoid", worst));
    if (peak.length) lines.push(wLine("busy", "Peak crowds", peak));
    // Weather that's a risk rather than a reason to stay away (red tide, sargassum, May Gray).
    var watch = events.filter(function (e) { return e.kind === "weather" && e.severity === "busy"; }).slice(0, 2)
      .map(function (e) { return "<b>" + wSpan(e.start_month, e.end_month) + "</b> · " + esc(e.name); });
    if (watch.length) lines.push(wLine("busy", "Watch for", watch));
    if (plan.length) lines.push(wLine("busy", "Plan around", plan));
    return lines.join("");
  }
  function whenStrip(events) {
    return WMON.map(function (mn, i) { var v = wSev(events, i + 1); return '<span class="' + (v || "") + '" title="' + mn + '">' + mn[0] + "</span>"; }).join("");
  }

  window.TV2 = {
    KIND: KIND, TENURE: TENURE, MON: MON, ICON: ICON, POST_COLS: POST_COLS,
    tenureBadge: tenureBadge, monthsLabel: monthsLabel, shortName: shortName,
    loadCity: loadCity, hydrate: hydrate, sortPosts: sortPosts, isSplit: isSplit, placeOf: placeOf,
    takeHtml: takeHtml, castVote: castVote, whenSummary: whenSummary, whenStrip: whenStrip, monthSeverity: wSev,
    loadQuestions: loadQuestions, qTotal: qTotal, answer: answer, qOptionsHtml: qOptionsHtml,
    prepareClaim: prepareClaim, finishClaim: finishClaim, signInForBadge: signInForBadge, saveTenure: saveTenure,
    drawShareCard: drawShareCard, shareCard: shareCard, ago: ago, answerKind: answerKind, loadPosts: loadPosts, POST_COLS_X: POST_COLS_X,
    share: share, takeShare: takeShare, questionShare: questionShare, shareLinks: shareLinks, track: track
  };
})();
