/* City page (city.html): moved out of the page in Nov 2026 so the browser caches it
   across cities instead of every city page carrying ~26 KB of inline script. */
(function(){
  "use strict";
  const { sb, $, escapeHtml: esc, auth } = window.TV;
  const T2 = window.TV2;
  const SLUG = window.TV.parseRoute().city;
  // Attribution for openly licensed hero photos (Wikimedia Commons etc.).
  const PHOTO_CREDIT = {
  };

  const SECTIONS = [["all","Everything"],["what_not_to_do","What not to do"],["worst_times","Worst times"],["hidden_gem","What locals do"]];
  let CITY = null, POSTS = [], CTX = null, QS = [], EVENTS = [], SECTION = "all", SORT = "top", VIBE = null;
  // The "Pick a vibe" row appears once this many takes and restaurants carry a shown vibe.
  const VIBE_FILTER_MIN = 5;
  // One section at a time. The hash deep-links a tab (#eat, #when, #guide; #top3 opens the picker).
  // The Guide replaced the Stay tab (Nov 2026); old #stay links open the Guide, which ends with the hotels.
  const TABS = [["takes","Takes"],["eat","Eat"],["when","When to go"],["guide","Guide"]];
  const tabFromHash = h => { h = String(h || "").replace(/^#/, ""); return h === "top3" ? "eat" : h === "stay" ? "guide" : TABS.some(t => t[0] === h) ? h : "takes"; };
  let TAB = tabFromHash(location.hash);
  // Section chips and sort only once there is enough to filter.
  const CHIPS_MIN_TAKES = 10;
  // Pre-rendered by the build: the TripVibz editors' intro (empty cities only)
  // and nearby-city links. Grab them before the first render replaces #city.
  const keep = id => { const el = document.getElementById(id); return el ? el.outerHTML : ""; };
  const EDITORS_HTML = keep("tv-editors"), NEARBY_HTML = keep("tv-nearby");
  // The hero photo is pre-rendered too (build.mjs heroImg: local resized copies,
  // fetchpriority=high) so it is the first thing the browser fetches.
  const HERO_HTML = keep("tv-hero");
  // Locals' top 3 and the Guide are pre-rendered too; shown as-is until their data arrives.
  const EATS_HTML = keep("tv-eats"), GUIDE_HTML = keep("tv-guide");
  const NT = { kind: "what_not_to_do", topic: "", text: "", busy: false, sent: false, err: "", open: false };
  const NT_KINDS = [["what_not_to_do","Don’t do this"],["hidden_gem","Do this"],["take","It depends"],["worst_times","When to go"]];

  // A take on something we didn't ask about. Waits for review before anyone else sees it.
  function topicBox(){
    if (NT.sent) return `<section class="nt" id="nt"><div class="nt-done"><b>Thanks, it's in.</b>New topics get a quick check before they go live, usually within a day. It's in the feed now marked "Waiting for review" (only you can see it).</div></section>`;
    const open = NT.open || !!(NT.topic || NT.text || NT.err);
    return `<details class="nt" id="nt" ${open ? "open" : ""}>
      <summary><span><b>Something we didn't ask about?</b><small>Start your own topic</small></span><i aria-hidden="true"></i></summary>
      <div class="nt-body">
      <p>Tell a friend something about ${esc(CITY.name)} we didn't ask. New topics get a quick check before they go live.</p>
      <label for="nt-topic">What's it about?</label>
      <input id="nt-topic" maxlength="80" autocapitalize="sentences" autocorrect="on" spellcheck="true" placeholder="e.g. Parking downtown, ${esc(CITY.name)} in August" value="${esc(NT.topic)}">
      <label>Your take is…</label>
      <div class="chips" role="group" aria-label="Kind of take">${NT_KINDS.map(([k,l]) => `<button class="chip" data-ntk="${k}" aria-pressed="${NT.kind===k}">${l}</button>`).join("")}</div>
      <label for="nt-text">Your take</label>
      <textarea id="nt-text" maxlength="400" autocapitalize="sentences" autocorrect="on" spellcheck="true" placeholder="One or two sentences. What should visitors know?">${esc(NT.text)}</textarea>
      ${NT.err ? `<div class="err" style="margin-top:8px">${esc(NT.err)}</div>` : ""}
      <button class="nt-send" id="nt-send" ${NT.busy ? "disabled" : ""}>${NT.busy ? "Sending…" : "Send for review"}</button>
      </div>
    </details>`;
  }

  async function sendTopic(){
    NT.topic = ($("#nt-topic").value || "").trim(); NT.text = ($("#nt-text").value || "").trim();
    if (NT.topic.length < 3) { NT.err = "Say what it's about in a few words."; render(); $("#nt-topic").focus(); return; }
    if (NT.text.length < 12) { NT.err = "Add a sentence or two so visitors know why."; render(); $("#nt-text").focus(); return; }
    NT.err = ""; NT.busy = true; render();
    try {
      if (!auth.me) await auth.ensure();
      const text = window.TV.tidy(NT.text);
      const title = text.length <= 160 ? text : text.slice(0, 157).replace(/\s+\S*$/, "") + "…";
      const { row } = await window.TV.submitTake({ title, body: text.length > 160 ? text : null, type: NT.kind,
        city_id: CITY.id, city_name: CITY.name, topic: NT.topic });
      if (row) POSTS.unshift(Object.assign({ ups: 0, downs: 0, comment_count: 0, status: "pending", topic: NT.topic }, row));
      NT.sent = true; NT.busy = false; render();
      T2.track("topic_submitted", { city: CITY.slug });
    } catch (e) {
      console.error(e); NT.busy = false;
      NT.err = window.TV.moderationMessage(e) || (/RATE_LIMITED/.test(String(e && e.message)) ? "You've posted a few today. Sign in to post more." : "That didn't send. Try again.");
      render();
    }
  }

  try { const s = new URLSearchParams(location.search).get("s"); if (s && SECTIONS.some(x => x[0] === s)) SECTION = s; } catch (e) {}

  function questionCard(){
    if (!QS.length) return "";
    const q = QS.find(x => !x.mine) || null;
    const base = `/${CITY.slug}/vote/`;
    if (!q) {
      const last = QS[0];
      return `<div class="qcard lite"><div class="qk">You've answered every question</div>
        <div class="qp">${esc(last.prompt)}</div>
        <div class="qopts">${T2.qOptionsHtml(last, true, base)}</div>
        <div class="qnote">${T2.qTotal(last)} vote${T2.qTotal(last) === 1 ? "" : "s"} so far. New questions every week.</div></div>`;
    }
    const total = T2.qTotal(q);
    return `<div class="qcard lite"><div class="qk">Settle this</div>
      <div class="qp">${esc(q.prompt)}</div>
      <div class="qopts">${T2.qOptionsHtml(q, true, base)}</div>
      <div class="qnote">One tap. ${total ? `See what ${total} other ${total === 1 ? "person" : "people"} said.` : "Be the first to answer."}</div></div>`;
  }

  // When to go: the month strip and summary (same data as the worst-times calendar).
  function whenPanel(){
    if (!EVENTS.length) return `<div class="empty2"><b>No calendar for ${esc(CITY.name)} yet</b>We're still checking the seasons and big events here.${
      POSTS.some(p => p.type === "worst_times") ? " “When to go” takes are under Takes." : ` Know ${esc(CITY.name)}? Tell a friend which months to skip.`}</div>`;
    return `<a class="when" href="/${esc(CITY.slug)}/worst-times-to-visit/">
      <div class="when-k">Best and worst months</div>
      <div class="when-strip">${T2.whenStrip(EVENTS)}</div>
      <div class="when-t">${T2.whenSummary(EVENTS)}</div>
      <div class="when-go">Month-by-month calendar →</div></a>`;
  }

  // Where to stay (the end of the Guide): the hotel map, then hotel links for the places and months people mention.
  function stayPanel(){
    const seen = new Set();
    const tips = POSTS.map(p => T2.stay22TakeLink(p, CTX, CITY, "city_stay")).filter(h => h && !seen.has(h) && seen.add(h));
    return `${T2.stay22MapHtml(CITY, "city_map")}${tips.length ? `<div class="stay-tips"><div class="when-k">Where people point friends</div><div class="stay-links">${tips.join("")}</div></div>` : ""}`;
  }

  // Guide: a map of the spots in the takes and the top restaurants, the top 3 restaurants
  // with how many people picked each and what they said, the spots, then where to stay
  // (assets/guide.js; build.mjs pre-renders the same markup). guide.js, the map library and
  // the tiles all load when the Guide is first opened, so the other tabs carry none of it.
  const GUIDE_SRC = (document.getElementById("city") || { dataset: {} }).dataset.guideSrc || "/assets/guide.js";
  let guideLoading = null;
  function loadGuide(){
    if (window.TVGuide) return Promise.resolve(true);
    if (guideLoading) return guideLoading;
    guideLoading = new Promise(resolve => {
      const s = document.createElement("script"), t = setTimeout(() => { guideLoading = null; resolve(false); }, 8000);
      s.src = GUIDE_SRC; s.async = true;
      s.onload = () => { clearTimeout(t); resolve(!!window.TVGuide); };
      s.onerror = () => { clearTimeout(t); guideLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return guideLoading;
  }
  function guidePanel(){
    if (!window.TVGuide || (!EATS.ready && GUIDE_HTML)) return GUIDE_HTML || `<div class="empty2"><b>Loading the guide…</b></div>`;
    const spots = TVGuide.spots(POSTS, Object.values((CTX && CTX.placeRows) || {}));
    const eats = TVGuide.topEats(EATS.rows, EATS.picks, EATS.verified, id => T2.shortName(EATS.profiles[id]), 3);
    return TVGuide.html(CITY, spots, eats, {
      pickers: new Set(EATS.picks.map(x => x.user_id)).size,
      hotelsNear: name => T2.stay22Link(CITY, { place: name, placement: "guide" }),
      stayHtml: stayPanel(),
      addHref: `/${CITY.slug}/add/`
    });
  }
  // The map loads (with its library and tiles) only once the Guide is on screen.
  function mountGuide(){
    if (TAB !== "guide") return;
    const had = !!window.TVGuide;
    loadGuide().then(ok => {
      const panel = $("#panel-guide"); if (!panel) return;
      if (!ok) { const w = panel.querySelector(".g-map-wait"); if (w) w.textContent = "The map didn't load. Everything on it is listed below."; return; }
      // First open: swap the pre-rendered Guide for the live one (only this panel, so a half-typed top 3 survives).
      if (!had && EATS.ready) { panel.innerHTML = guidePanel(); T2.mountStay22(panel); }
      TVGuide.mountMap(panel).then(m => { if (m) T2.track("guide_map", { city: CITY.slug }); });
    });
  }

  /* ---------- Locals' top 3 restaurants ----------
     Data: restaurants + top3_picks (migration 20261030140000), rolled up by the
     city_top_restaurants view. Markup matches build.mjs eatsHtml, so the
     pre-rendered section is refreshed in place. Anyone signed in (not an
     anonymous session) keeps one ranked list per city; verified locals lead. */
  const EATS = { rows: [], picks: [], rests: [], profiles: {}, verified: new Set(), mine: [], open: false, busy: false, err: "", saved: false, ready: false, draft: {}, vibes: { counts: {}, mine: {} } };
  const nameKey = n => String(n || "").toLowerCase().replace(/^\s*the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();   // mirrors restaurants.name_key
  const signedInUser = () => auth.me && !auth.me.is_anonymous ? auth.me : null;

  async function loadEats(){
    const [r, p, rs] = await Promise.all([
      sb.from("city_top_restaurants").select("*").eq("city_id", CITY.id),
      sb.from("top3_picks").select("user_id,rank,restaurant_id,why").eq("city_id", CITY.id),
      sb.from("restaurants").select("id,name,neighborhood,hidden,merged_into,place_id,address").eq("city_id", CITY.id)
    ]);
    EATS.rows = (r.data || []).sort((a, b) => b.verified_points - a.verified_points || b.points - a.points || b.firsts - a.firsts || a.name.localeCompare(b.name)).slice(0, 10);
    EATS.picks = p.data || []; EATS.rests = rs.data || [];
    const ids = [...new Set(EATS.picks.map(x => x.user_id))];
    if (ids.length) {
      const [pr, lc] = await Promise.all([
        sb.from("profiles").select("id,display_name,username").in("id", ids),
        sb.from("local_checks").select("user_id,verified,revoked").eq("city_id", CITY.id).in("user_id", ids)
      ]);
      (pr.data || []).forEach(x => { EATS.profiles[x.id] = x; });
      EATS.verified = new Set((lc.data || []).filter(x => x.verified && !x.revoked).map(x => x.user_id));
    }
    const me = signedInUser();
    EATS.mine = me ? EATS.picks.filter(x => x.user_id === me.id).sort((a, b) => a.rank - b.rank) : [];
    try { EATS.vibes = await T2.loadRestaurantVibes(CITY.id); } catch (e) { EATS.vibes = { counts: {}, mine: {} }; }
    EATS.ready = true;
  }

  // Address, directions, call, website, hotels-near — only what the row has.
  function eatLinks(r){
    const parts = [];
    if (r.lat && r.lng) parts.push(`<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.lat + "," + r.lng)}" target="_blank" rel="noopener">Directions</a>`);
    else if (r.address) parts.push(`<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.name + ", " + r.address + ", " + CITY.name)}" target="_blank" rel="noopener">Directions</a>`);
    if (r.phone) parts.push(`<a href="tel:${esc(String(r.phone).replace(/[^+\d]/g, ""))}">Call</a>`);
    if (r.website) parts.push(`<a href="${esc(r.website)}" target="_blank" rel="noopener nofollow">Website</a>`);
    const hotels = T2.stay22Link(CITY, { place: r.name, placement: "top3" });
    if (hotels) parts.push(`<a href="${esc(hotels)}" target="_blank" rel="noopener sponsored">Hotels near</a>`);
    return parts.length ? `<div class="eat-links">${parts.join("")}</div>` : "";
  }

  function eatsHtml(){
    const whyFor = id => {
      const w = EATS.picks.filter(x => x.restaurant_id === id && x.why).sort((a, b) => (EATS.verified.has(b.user_id) - EATS.verified.has(a.user_id)) || a.rank - b.rank)[0];
      return w ? `<div class="eat-why">“${esc(w.why)}” <span class="eat-by">— ${esc(T2.shortName(EATS.profiles[w.user_id]))}${EATS.verified.has(w.user_id) ? " ✓" : ""}</span></div>` : "";
    };
    const people = new Set(EATS.picks.map(x => x.user_id)).size;
    const rows = VIBE ? EATS.rows.filter(r => ((EATS.vibes.counts[r.restaurant_id] || {})[VIBE] || 0) >= T2.VIBE_SHOW_AT) : EATS.rows;
    const list = rows.length ? `<ol class="eats-list">${rows.map(r => `<li>
      <div class="eat-main"><b class="eat-name">${esc(r.name)}</b>${r.address ? `<span class="eat-nb">${esc(r.address)}${r.neighborhood ? ", " + esc(r.neighborhood) : ""}</span>` : r.neighborhood ? `<span class="eat-nb">${esc(r.neighborhood)}</span>` : ""}
      <div class="eat-meta">${r.picks} pick${r.picks === 1 ? "" : "s"}${r.verified_picks ? ` · ${r.verified_picks} verified ✓` : ""}${r.firsts ? ` · #1 for ${r.firsts}` : ""}</div>
      ${T2.vibeTagsHtml(EATS.vibes.counts[r.restaurant_id], EATS.vibes.mine[r.restaurant_id])}${whyFor(r.restaurant_id)}${eatLinks(r)}</div></li>`).join("")}</ol>
      <div class="eats-attrib">Addresses and phone numbers from <a href="https://overturemaps.org/" target="_blank" rel="noopener">Overture Maps</a> (open data); please <a href="/about/#contact">tell us</a> if one is wrong.</div>`
      : VIBE ? `<div class="empty2"><b>No ${esc(T2.VIBE_BY[VIBE].label.toLowerCase())} picks yet</b>Pick your top 3 and tag the vibe.</div>`
      : `<div class="empty2"><b>No picks yet</b>Know ${esc(CITY.name)}? Be the first to name the three places you'd take a friend.</div>`;
    return `<section class="eats" id="tv-eats" aria-labelledby="eats-h">
      <div class="eats-h"><h2 id="eats-h">Where they'd take a friend to eat</h2>${people ? `<span class="eats-n">${people} ${people === 1 ? "person" : "people"} picked</span>` : ""}</div>
      ${vibeFilter()}
      ${list}
      ${top3Box()}
    </section>`;
  }

  // The picker. Signed in: three name + why rows. Otherwise: a sign-in button.
  function top3Box(){
    const me = signedInUser();
    if (!me) return `<div class="eats-add" id="top3"><button class="btn2" id="top3-signin">Know it? Add your top 3</button><span class="eats-note">Sign in and pick three; verified locals' picks lead. <a href="/how-we-verify-locals/">How badges work</a>.</span></div>`;
    if (!EATS.open) {
      const mine = EATS.mine.map(x => (EATS.rests.find(r => r.id === x.restaurant_id) || {}).name).filter(Boolean);
      return `<div class="eats-add" id="top3"><button class="btn2${mine.length ? " ghost" : ""}" id="top3-open">${mine.length ? "Edit your top 3" : "Add your top 3"}</button>${
        mine.length ? `<span class="eats-note">Yours: ${mine.map(esc).join(", ")}${EATS.saved ? " · saved" : ""}</span>` : `<span class="eats-note">Three places you'd actually send a visitor.</span>`}</div>`;
    }
    // What's typed lives in EATS.draft, so a validation message never wipes the form.
    // Typing searches the places catalogue (search_places); picking a result pins
    // its place_id so the restaurant row is created server-side from real data.
    const rows = [1, 2, 3].map(rank => {
      const d = EATS.draft[rank] || {};
      return `<div class="top3-row"><span class="n">${rank}</span><div class="top3-field">
        <input id="top3-n${rank}" data-top3="n${rank}" maxlength="80" autocapitalize="words" autocomplete="off" placeholder="${rank === 1 ? "Start typing a restaurant" : "Another place (optional)"}" value="${esc(d.name || "")}">
        ${d.place_id ? `<div class="top3-picked">✓ ${esc(d.address || "")}${d.locality ? ", " + esc(d.locality) : ""}</div>` : (d.name && d.name.length >= 2 && d.searched) ? `<div class="top3-picked plain">Not in our list — we'll add it as typed.</div>` : ""}
        <div class="top3-sugg" id="top3-s${rank}" hidden></div>
        <input id="top3-w${rank}" data-top3="w${rank}" maxlength="100" autocapitalize="sentences" placeholder="Why, in a few words (optional)" value="${esc(d.why || "")}">
        ${d.name ? `<div class="vibe-k">The vibe (up to 2)</div>${T2.vibePickHtml("r" + rank, d.vibes || [], "restaurant")}` : ""}</div></div>`;
    }).join("");
    return `<div class="top3" id="top3">
      <h3>Your top 3 in ${esc(CITY.name)}</h3>
      <p>Where you'd actually send a visitor. Start typing and pick the place from the list so the address and phone come with it. One list per person; change it any time.</p>
      ${rows}
      ${EATS.err ? `<div class="err">${esc(EATS.err)}</div>` : ""}
      <div class="top3-acts"><button class="btn2" id="top3-save" ${EATS.busy ? "disabled" : ""}>${EATS.busy ? "Saving…" : "Save my top 3"}</button><button class="btn2 ghost" id="top3-cancel">Cancel</button></div>
    </div>`;
  }

  EATS.sugg = {}; EATS.timers = {}; EATS.popular = null;
  // One suggestion row: name, address, and how well known it is (reviews, or TripVibz picks).
  const suggItem = (r, rank) => `<button type="button" data-pick="${esc(r.id)}" data-rank="${rank}"><b>${esc(r.name)}</b><small>${esc([r.address, r.locality].filter(Boolean).join(", "))}${
    r.review_count ? ` · ${Number(r.review_count).toLocaleString()} reviews` : r.picks ? ` · picked by ${r.picks} ${r.picks === 1 ? "person" : "people"}` : ""}${r.status === "closed" ? " · may be closed" : ""}</small></button>`;
  // Before typing: the city's best-known places (popular_places), one tap away.
  async function showPopular(rank){
    const box = $(`#top3-s${rank}`); if (!box) return;
    if (EATS.popular === null) { const { data } = await sb.rpc("popular_places", { p_city: CITY.id }); EATS.popular = data || []; }
    const cur = $(`#top3-n${rank}`); if (!cur || cur.value.trim() || !EATS.popular.length) return;
    EATS.sugg[rank] = EATS.popular;
    box.innerHTML = `<div class="sugg-k">Best known in ${esc(CITY.name)}</div>` + EATS.popular.map(r => suggItem(r, rank)).join("");
    box.hidden = false;
  }
  function suggest(rank, text){
    clearTimeout(EATS.timers[rank]);
    const box = $(`#top3-s${rank}`); if (!box) return;
    const q = (text || "").trim();
    if (!q) { showPopular(rank); return; }
    if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
    EATS.timers[rank] = setTimeout(async () => {
      const { data } = await sb.rpc("search_places", { p_city: CITY.id, p_q: q });
      const cur = $(`#top3-n${rank}`); if (!cur || cur.value.trim() !== q) return;   // they kept typing
      EATS.sugg[rank] = data || [];
      const items = EATS.sugg[rank].map(r => suggItem(r, rank));
      items.push(`<button type="button" class="typed" data-pick="typed" data-rank="${rank}">Use “${esc(q)}” as typed<small>${EATS.sugg[rank].length ? "Not one of these?" : "Not in our list yet"} — we'll add it.</small></button>`);
      box.innerHTML = items.join(""); box.hidden = false;
    }, 220);
  }

  function openTop3(){
    const byId = id => EATS.rests.find(r => r.id === id) || {};
    EATS.draft = {};
    EATS.mine.forEach(x => { const r = byId(x.restaurant_id); EATS.draft[x.rank] = { name: r.name || "", why: x.why || "", place_id: r.place_id || null, address: r.address || null, locality: r.neighborhood || null, searched: true, vibes: (EATS.vibes.mine[x.restaurant_id] || []).slice(0, 2) }; });
    EATS.open = true; EATS.saved = false; EATS.err = "";
  }

  async function saveTop3(){
    const me = signedInUser(); if (!me) return;
    const wanted = [];
    for (const rank of [1, 2, 3]) {
      const d = EATS.draft[rank] || {};
      const name = (d.name || "").replace(/\s+/g, " ").trim();
      const why = (d.why || "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      if (name.length < 2) { EATS.err = "That name is too short."; render(); return; }
      if (wanted.some(w => nameKey(w.name) === nameKey(name))) { EATS.err = "You listed the same place twice."; render(); return; }
      wanted.push({ rank, name, why: why || null, place_id: d.place_id || null, vibes: d.vibes || [] });
    }
    if (!wanted.length) { EATS.err = "Name at least one place."; render(); return; }
    EATS.err = ""; EATS.busy = true; render();
    try {
      // Match typed names to existing rows (same key the database uses), create the rest.
      const rows = [];
      for (const w of wanted) {
        if (w.place_id) {
          // From the catalogue: the database creates (or finds) the row and copies the details itself.
          const rp = await sb.rpc("ensure_restaurant_from_place", { p_place: w.place_id });
          if (rp.error) throw rp.error;
          rows.push({ user_id: me.id, city_id: CITY.id, rank: w.rank, restaurant_id: rp.data, why: w.why });
          continue;
        }
        let r = EATS.rests.find(x => !x.place_id && nameKey(x.name) === nameKey(w.name)) || EATS.rests.find(x => nameKey(x.name) === nameKey(w.name));
        if (r && r.merged_into) r = EATS.rests.find(x => x.id === r.merged_into) || r;
        if (!r) {
          const ins = await sb.from("restaurants").insert({ city_id: CITY.id, name: w.name, created_by: me.id }).select("id,name,neighborhood,hidden,merged_into,place_id,address").single();
          if (ins.error) {
            // Someone added it a moment ago: re-read and match again.
            const again = await sb.from("restaurants").select("id,name,neighborhood,hidden,merged_into,place_id,address").eq("city_id", CITY.id);
            EATS.rests = again.data || EATS.rests;
            r = EATS.rests.find(x => nameKey(x.name) === nameKey(w.name));
            if (!r) throw ins.error;
          } else { r = ins.data; EATS.rests.push(r); }
        }
        rows.push({ user_id: me.id, city_id: CITY.id, rank: w.rank, restaurant_id: r.id, why: w.why });
      }
      // Replace the list wholesale (ranks may have swapped places).
      const del = await sb.from("top3_picks").delete().eq("user_id", me.id).eq("city_id", CITY.id);
      if (del.error) throw del.error;
      const ins = await sb.from("top3_picks").insert(rows);
      if (ins.error) throw ins.error;
      // The vibes go with the restaurant, not the rank: one list per restaurant.
      const want = {};
      rows.forEach(x => { const w = wanted.find(y => y.rank === x.rank); want[x.restaurant_id] = (w && w.vibes) || []; });
      if (!(await T2.saveMyVibes("restaurant_id", want, CITY.id)) && Object.values(want).some(v => v.length)) window.TV.toast("Your top 3 saved, but the vibes didn't");
      T2.track("top3_saved", { city: CITY.slug, n: rows.length });
      EATS.open = false; EATS.saved = true; EATS.busy = false;
      await loadEats(); render();
    } catch (e) {
      console.error(e); EATS.busy = false;
      const m = String(e && e.message || "");
      EATS.err = window.TV.moderationMessage(e) || (/RATE_LIMITED/.test(m) ? "You've added a lot of new places today. Try again tomorrow." : /WRONG_CITY/.test(m) ? "That place belongs to another city." : /UNKNOWN_PLACE/.test(m) ? "That place isn't in our list any more — type the name instead." : "That didn't save. Try again.");
      render();
    }
  }

  // "Pick a vibe": shown once enough takes and restaurants carry a vibe (2+ people each).
  function vibedCounts(){
    const n = {}; let items = 0;
    const add = counts => { let any = false; Object.keys(counts || {}).forEach(k => { if (counts[k] >= T2.VIBE_SHOW_AT) { n[k] = (n[k] || 0) + 1; any = true; } }); if (any) items++; };
    POSTS.forEach(p => add(CTX && CTX.vibes[p.id]));
    EATS.rows.forEach(r => add(EATS.vibes.counts[r.restaurant_id]));
    return { n, items };
  }
  function vibeFilter(){
    const { n, items } = vibedCounts();
    if (items < VIBE_FILTER_MIN) return "";
    const vs = T2.VIBES.filter(v => n[v.slug]);
    return `<div class="vibe-k">Pick a vibe</div><div class="vibe-filter" role="group" aria-label="Pick a vibe">${vs.map(v =>
      `<button type="button" class="vibe" data-vfilter="${v.slug}" aria-pressed="${VIBE === v.slug}">${esc(v.label)} <span class="vn">${n[v.slug]}</span></button>`).join("")}</div>`;
  }

  function heroBand(){
    const n = POSTS.length;
    const img = HERO_HTML || `<img class="city-hero band" ${TV.cityPhotoAttrs(CITY, "(max-width: 640px) calc(100vw - 32px), 608px")} alt="${esc(CITY.name)}" width="800" height="400" fetchpriority="high" decoding="async">`;
    return `<div class="hero-band">${img}<div class="hero-txt">
        <div class="kicker">${esc(CITY.name)}${CITY.state ? ", " + esc(CITY.state) : ""}</div>
        <h1>Know ${esc(CITY.name)}?</h1>
        <div class="hero-n">${n ? `${n} take${n === 1 ? "" : "s"} from people who know it` : "Be the first to weigh in"}</div></div></div>
      ${PHOTO_CREDIT[CITY.slug] ? `<a class="photo-credit" href="${PHOTO_CREDIT[CITY.slug][1]}" target="_blank" rel="noopener">Photo: ${esc(PHOTO_CREDIT[CITY.slug][0])}</a>` : ""}`;
  }

  function tabsHtml(){
    return `<div class="tabs" role="tablist" aria-label="Sections">${TABS.map(([id, l]) =>
      `<button role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${TAB === id}" aria-controls="panel-${id}" tabindex="${TAB === id ? 0 : -1}">${l}</button>`).join("")}</div>`;
  }

  // Takes: the question first, then the takes. Filters appear once there's enough to filter.
  function takesPanel(){
    const many = POSTS.length >= CHIPS_MIN_TAKES;
    if (!many) SECTION = "all";
    const list = T2.sortPosts(POSTS.filter(p => (SECTION === "all" || p.type === SECTION) && (!VIBE || ((CTX.vibes[p.id] || {})[VIBE] || 0) >= T2.VIBE_SHOW_AT)), SORT);
    const topics = [["what_not_to_do","what-not-to-do","What not to do"],["hidden_gem","what-locals-do","What locals do"],["worst_times","worst-times-to-visit","Worst times to visit"]];
    return `${questionCard()}
      ${POSTS.length < 3 ? EDITORS_HTML : ""}
      ${vibeFilter()}
      ${many ? `<nav class="chips" aria-label="Show">${SECTIONS.map(([id,l]) => `<button class="chip" data-sec="${id}" aria-pressed="${SECTION===id}">${l}</button>`).join("")}</nav>
      <div class="seg" role="group" aria-label="Sort" style="margin:2px 0 12px">${[["top","Top"],["hot","Hot"],["new","New"]].map(([id,l]) => `<button data-sort="${id}" aria-pressed="${SORT===id}">${l}</button>`).join("")}</div>` : ""}
      <div class="feed" id="feed">${list.length ? list.map(p => T2.takeHtml(p, CTX, { city: CITY, placement: "city_feed" })).join("") :
        VIBE ? `<div class="empty2"><b>No ${esc(T2.VIBE_BY[VIBE].label.toLowerCase())} takes yet</b>Know a place for it? Add a “Do this” take and tag the vibe.</div>` :
        POSTS.length ? `<div class="empty2"><b>Nothing in this section yet</b>Try “Everything”, or add one below.</div>` :
        `<div class="empty2"><b>No takes yet</b>Know ${esc(CITY.name)}? Tap an answer in the question above, or start your own topic below. The first 10 verified locals to post become founding locals.</div>`}</div>
      ${topicBox()}
      ${POSTS.length ? `<div class="more-topics">By topic: ${topics.filter(t => POSTS.some(p => p.type === t[0])).map(t => `<a href="/${esc(CITY.slug)}/${t[1]}/">${t[2]}</a>`).join(" · ")}</div>` : ""}`;
  }

  // The bar follows the tab: on Eat it asks for a top 3, everywhere else for a take.
  function ctaBar(){
    const taken = CTX ? CTX.founderCount : 0, left = taken > 0 && taken < 10 ? 10 - taken : 0;
    const eat = TAB === "eat";
    return `<div class="cta-bar"><div class="cta-t">Know ${esc(CITY.name)}?${!eat && left ? `<small>${left} founding local spot${left === 1 ? "" : "s"} left</small>` : ""}</div>${
      eat ? `<a class="cta-btn" href="#top3">Add your top 3</a>` : `<a class="cta-btn" href="/${esc(CITY.slug)}/add/">Add your take</a>`}</div>`;
  }

  function render(){
    const panel = (id, html) => `<section class="panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}"${TAB === id ? "" : " hidden"}>${html}</section>`;
    $("#city").innerHTML = `
      ${heroBand()}
      ${tabsHtml()}
      ${panel("takes", takesPanel())}
      ${panel("eat", EATS.ready ? eatsHtml() : EATS_HTML)}
      ${panel("when", whenPanel())}
      ${panel("guide", guidePanel())}
      ${T2.emailSignupHtml(CITY, "city_page")}
      ${NEARBY_HTML}
      ${ctaBar()}`;
    wire();
    T2.mountStay22($("#city"));
    T2.mountEmailSignup($("#city"), CITY);
    mountGuide();
  }

  // Switch sections in place (no re-render, so a half-typed top 3 survives).
  function showTab(id, opts){
    opts = opts || {};
    TAB = id;
    $("#city").querySelectorAll("[role=tab]").forEach(b => { const on = b.dataset.tab === id; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; if (on && opts.focus) b.focus(); });
    $("#city").querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== "panel-" + id; });
    if (opts.hash !== false) { try { history.replaceState(null, "", id === "takes" ? location.pathname + location.search : "#" + id); } catch (e) {} }
    const bar = $("#city .cta-bar"); if (bar) bar.outerHTML = ctaBar();
    T2.mountStay22($("#city"));
    mountGuide();
    if (opts.track) T2.track("city_tab", { city: CITY.slug, tab: id });
  }
  function onHash(){
    showTab(tabFromHash(location.hash), { hash: false });
    if (location.hash === "#top3" && signedInUser() && !EATS.open) { openTop3(); render(); }
    if (location.hash === "#top3") { const el = $("#top3"); if (el) el.scrollIntoView({ block: "center" }); }
  }

  function wire(){
    $("#city").querySelectorAll("[role=tab]").forEach(b => {
      b.addEventListener("click", () => showTab(b.dataset.tab, { track: true }));
      b.addEventListener("keydown", e => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = TABS.findIndex(t => t[0] === TAB), n = TABS.length;
        showTab(TABS[(i + (e.key === "ArrowRight" ? 1 : n - 1)) % n][0], { track: true, focus: true }); e.preventDefault();
      });
    });
    $("#city").querySelectorAll("[data-sec]").forEach(b => b.addEventListener("click", () => { SECTION = b.dataset.sec; render(); }));
    $("#city").querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => { SORT = b.dataset.sort; render(); }));
    $("#city").querySelectorAll("[data-ntk]").forEach(b => b.addEventListener("click", () => {
      NT.topic = $("#nt-topic").value; NT.text = $("#nt-text").value; NT.kind = b.dataset.ntk; render();
    }));
    const ns = $("#nt-send"); if (ns) ns.addEventListener("click", sendTopic);
    const t3s = $("#top3-signin"); if (t3s) t3s.addEventListener("click", () => { T2.track("top3_signin", { city: CITY.slug }); T2.signInForBadge({ pending: false }); });
    const t3o = $("#top3-open"); if (t3o) t3o.addEventListener("click", () => { openTop3(); render(); const f = $("#top3-n1"); if (f) f.focus({ preventScroll: true }); });
    $("#city").querySelectorAll("[data-top3]").forEach(inp => inp.addEventListener("input", () => {
      const k = inp.dataset.top3, rank = Number(k.slice(1)); EATS.draft[rank] = EATS.draft[rank] || {};
      if (k[0] === "w") { EATS.draft[rank].why = inp.value; return; }
      // A new name un-pins any place chosen before.
      Object.assign(EATS.draft[rank], { name: inp.value, place_id: null, address: null, locality: null, lat: null, lng: null, searched: false });
      const picked = inp.parentNode.querySelector(".top3-picked"); if (picked) picked.remove();
      suggest(rank, inp.value);
    }));
    $("#city").querySelectorAll("[data-top3^='n']").forEach(inp => {
      inp.addEventListener("focus", () => { if (!inp.value.trim()) showPopular(Number(inp.dataset.top3.slice(1))); });
      inp.addEventListener("blur", () => setTimeout(() => { const b = $(`#top3-s${inp.dataset.top3.slice(1)}`); if (b && !b.matches(":hover")) { b.hidden = true; } }, 150));
    });
    $("#city").querySelectorAll(".top3-sugg").forEach(box => box.addEventListener("click", e => {
      const b = e.target.closest("button[data-pick]"); if (!b) return;
      const rank = Number(b.dataset.rank);
      const d = EATS.draft[rank] = EATS.draft[rank] || {};
      if (b.dataset.pick === "typed") { d.place_id = null; d.searched = true; }
      else { const r = (EATS.sugg[rank] || []).find(x => x.id === b.dataset.pick); if (r) Object.assign(d, { name: r.name, place_id: r.id, address: r.address, locality: r.locality, lat: r.lat, lng: r.lng, searched: true }); }
      render(); const w = $(`#top3-w${rank}`); if (w) w.focus({ preventScroll: true });
    }));
    $("#city").querySelectorAll("[data-vfilter]").forEach(b => b.addEventListener("click", () => {
      VIBE = VIBE === b.dataset.vfilter ? null : b.dataset.vfilter;
      if (VIBE) T2.track("vibe_filter", { city: CITY.slug, vibe: VIBE });
      render();
    }));
    const top3 = $("#top3");
    if (top3) top3.addEventListener("click", e => {
      const more = e.target.closest("[data-more-vibes]"); if (more) { T2.expandMood(more, "restaurant"); return; }
      const b = e.target.closest("[data-pick-vibe]"); if (!b) return;
      const [key, slug] = b.dataset.pickVibe.split(":"), rank = Number(key.slice(1));
      const d = EATS.draft[rank] = EATS.draft[rank] || {};
      const next = T2.togglePick(d.vibes, slug);
      if (!next) { window.TV.toast("Two vibes per place. Tap one to swap it."); return; }
      d.vibes = next; b.setAttribute("aria-pressed", String(next.indexOf(slug) >= 0));
    });
    const t3c = $("#top3-cancel"); if (t3c) t3c.addEventListener("click", () => { EATS.open = false; EATS.err = ""; render(); });
    const t3v = $("#top3-save"); if (t3v) t3v.addEventListener("click", saveTop3);
    const nt = $("#nt"); if (nt && nt.tagName === "DETAILS") nt.addEventListener("toggle", () => { NT.open = nt.open; if (nt.open) { const f = $("#nt-topic"); if (f && !f.value) f.focus({ preventScroll: true }); } });
    $("#feed").addEventListener("click", async e => {
      const b = e.target.closest("[data-vote]"); if (!b) return;
      const p = POSTS.find(x => x.id === b.dataset.id); if (!p) return;
      await T2.castVote(p, CTX, Number(b.dataset.vote));
      const card = b.closest(".take"); card.outerHTML = T2.takeHtml(p, CTX, { city: CITY, placement: "city_feed" });
    });
  }

  (async function init(){
    if (!SLUG) { $("#city").innerHTML = `<div class="state"><b>No city</b><a href="/cities/">Pick a city</a></div>`; return; }
    CITY = await T2.loadCity(SLUG);
    if (!CITY) { $("#city").innerHTML = `<div class="state"><b>City not found</b><a href="/cities/">← All cities</a></div>`; return; }
    // Same title the build gives the page (build.mjs cityTitle), so the tab doesn't change on load.
    document.title = `${CITY.name}${CITY.state ? ", " + CITY.state : ""} — where to go, what to skip, when to come`;
    // Recently viewed, for the quick picks on the Cities page (this browser only; nothing is sent).
    try { const k = "tv_recent_cities", r = JSON.parse(localStorage.getItem(k) || "[]").filter(s => s !== CITY.slug); r.unshift(CITY.slug); localStorage.setItem(k, JSON.stringify(r.slice(0, 5))); } catch (e) {}
    await auth.ensure();
    await T2.finishClaim();
    POSTS = await T2.loadPosts(CITY.id, ["what_not_to_do","worst_times","hidden_gem","take"]);
    let evs;
    [CTX, QS, evs] = await Promise.all([T2.hydrate(POSTS, CITY.id), T2.loadQuestions(CITY.id),
      sb.from("city_events").select("name,kind,severity,start_month,end_month").eq("city_id", CITY.id).eq("status", "approved")]);
    EVENTS = (evs && evs.data) || [];
    render();
    window.addEventListener("hashchange", onHash);
    // Top 3 loads after the first paint; the pre-rendered section stands in until then.
    try { await loadEats(); } catch (e) { console.error(e); }
    render();
    if (location.hash === "#top3") onHash();
  })();
})();
