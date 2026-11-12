// The visitor flows: everything the site lets a person enter, done in a real
// browser, followed by coming back as the same person to see it still there.
//
// Two suites run these same flows against different "databases":
//   tests/regression.mjs  an in-memory copy (runs anywhere; live data for reads)
//   tests/database.mjs    a throwaway copy of the real database, built from this
//                         repo, where every save goes through the real
//                         permissions, triggers and limits
// so a flow can't pass in one and mean something else in the other.
//
// A backend gives:
//   read(path)                  → rows, as a signed-out visitor sees them (PostgREST path)
//   newPerson({ signedIn })     → { id, user, session }
//   attach(ctx, who)            → routes the browser's database and /api calls
//   addOtherTake(row) / removeTake(id)   another person's approved take
//   stored(table, personId)     → how many rows that person owns there
//   writes                      [{ target, method, body, who }] every save the pages sent
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SB = "https://nkxorlktzbgwqnfwmuus.supabase.co";
export const KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB";
export const VIEW = { width: 390, height: 844 };

// Which column says whose row it is.
export const OWNER_COLUMN = { question_votes: "user_id", votes: "user_id", vibe_tags: "user_id", top3_picks: "user_id", city_tenure: "user_id",
  city_requests: "user_id", comments: "author_id", posts: "author_id", restaurants: "created_by" };
export const READ_ONLY_RPCS = ["question_results", "search_places", "popular_places", "search_take_places"];

// ---- the list: every write the pages make either comes back (checked below) or has a reason not to ----
export const COMES_BACK = ["question_votes", "posts", "/api/take", "votes", "vibe_tags", "city_tenure", "comments", "city_requests", "top3_picks", "restaurants"];
export const NOTHING_TO_SHOW = {
  "profiles": "copies the Google name and photo onto the profile at sign-in; nothing the person entered",
  "rpc:question_results": "a read (tallies)",
  "rpc:search_places": "a read (restaurant search)",
  "rpc:popular_places": "a read (best-known restaurants)",
  "rpc:search_take_places": "a read (spot search)",
  "rpc:ensure_restaurant_from_place": "server-side copy of a catalogue restaurant; the pick that uses it is checked (top3_picks)",
  "rpc:ensure_spot_from_place": "server-side copy of a catalogue spot; the take that uses it is checked (posts)",
  "rpc:create_claim": "sign-in handoff token, not something the person did on a page",
  "rpc:redeem_claim": "sign-in handoff: moves anonymous answers to the account (tests/e2e.mjs covers sign-in)",
  "rpc:email_signup": "email list signup has no account; there is nothing to show on return",
  "/api/hit": "page-view counter",
  "/api/error": "error beacon",
  "/api/locate": "location check for the Local badge; the badge is earned over weeks, not shown on return",
  "/api/near": "a read (cities near you)",
  "/api/event": "calendar suggestion; goes to review and is not shown until approved"
};

export async function visitorFlows({ browser, BASE, backend, test, assert }) {
  const writes = backend.writes;

  async function person({ signedIn = false } = {}) {
    const who = await backend.newPerson({ signedIn });
    const { id, user, session } = who;
    const ctx = await browser.newContext({ viewport: VIEW, serviceWorkers: "block" });
    ctx.setDefaultTimeout(8000);   // a missing button should fail the check in seconds, with its own message
    // A signed-in person arrives with their session; an anonymous one gets theirs on the first thing they do.
    if (signedIn) await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch {} }, ["sb-nkxorlktzbgwqnfwmuus-auth-token", JSON.stringify(session)]);
    await ctx.route(`${SB}/auth/v1/**`, r => r.fulfill({ json: r.request().url().includes("/user") ? user : session }));
    await backend.attach(ctx, who);
    const errors = [];
    const me = { id, ctx, errors, page: null, token: session.access_token };
    // open(): first visit, or coming back. Coming back closes the old tab first, so nothing a page
    // kept in its own variables or in sessionStorage survives; only the person's session does.
    me.open = async path => {
      if (me.page) await me.page.close();
      const p = me.page = await ctx.newPage();
      p.on("pageerror", e => errors.push(`${path}: ${e.message}`));
      await p.goto(BASE + path, { waitUntil: "networkidle" }); await p.waitForTimeout(800);
      return p;
    };
    me.wrote = (target, since = 0) => writes.slice(since).filter(w => w.who === id && w.target === target);
    return me;
  }

  const covered = new Set();   // write targets a check below actually sent and then saw come back
  async function comesBack(who, targets, name, fn) {
    await test(`Comes back: ${name}`, async () => {
      const before = writes.length;
      await fn();
      const sent = new Set(writes.slice(before).map(w => w.target));
      for (const group of targets) {   // a group is one target, or alternatives ("posts" directly or through /api/take)
        const alts = [].concat(group);
        assert(alts.some(t => sent.has(t)), `this check is listed as covering ${alts.join(" or ")}, but nothing was written there. The page changed how it saves; update this check`);
        const table = alts.includes("/api/take") ? "posts" : alts[0];
        const n = await backend.stored(table, who.id);
        assert(n >= 1, `the page showed it as saved, but ${backend.name} holds no ${table} row for this person`);
        alts.forEach(t => covered.add(t));
      }
    });
  }

  const cities = await backend.read("cities?select=id,slug,name&order=sort");
  const city = slug => cities.find(c => c.slug === slug);
  const nash = city("nashville");
  const nashQs = await backend.read(`questions?select=id,prompt&city_id=eq.${nash.id}&active=eq.true&order=sort`);
  const livePosts = await backend.read("posts?select=id,city_id,type&status=eq.approved&order=ups.desc&limit=40");
  assert(nashQs.length >= 2, "Nashville needs at least two active questions for these checks");
  assert(livePosts.length >= 1, "these checks need at least one approved take");

  const anon = await person();
  const [q1, q2] = nashQs;
  const card = (p, q) => p.locator(`#qlist [data-q="${q.id}"]`);
  const WHY = "REGRESSION TEST go on a weekday before noon, it is a different place";

  await comesBack(anon, ["question_votes"], "an answered question shows your answer on the add page and counts toward your progress, and the city page moves on to the next one", async () => {
    let p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator(".qopt.mine").count() === 0, "a first-time visitor should not have an answer yet");
    await card(p, q1).locator(".qopt").first().click(); await p.waitForTimeout(500);
    assert(anon.wrote("question_votes").length === 1, "the answer was not sent");
    p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator('.qopt.mine[aria-pressed="true"]').count() === 1, "back on the add page, the question you answered is shown as unanswered");
    assert(/^1 of /.test((await p.textContent(".progress")).trim()), `progress should count the answer you gave: "${await p.textContent(".progress")}"`);
    assert(await card(p, q1).locator(".why-box").count() === 0, "coming back should not reopen the why box as if you had just answered");
    p = await anon.open("/nashville/");
    // The city page's card moves on to the next unanswered question.
    assert(await p.locator(`.qcard a.qopt[href*="q=${q1.id}"]`).count() === 0, "the city page asks a question you already answered");
    assert((await p.textContent(".qcard .qp")).trim() === q2.prompt, `the city page should move on to the next question: "${await p.textContent(".qcard .qp")}"`);
  });

  await comesBack(anon, [["posts", "/api/take"]], "a take you wrote on a question is shown as yours, the question doesn't ask for it again, and it isn't offered back to you as someone else's", async () => {
    let p = await anon.open("/nashville/add/");
    await card(p, q1).locator(".qopt.mine").click(); await p.waitForTimeout(400);   // tapping your answer again opens the why box
    await card(p, q1).locator("[data-why]").fill(WHY);
    await card(p, q1).locator("[data-post-why]").click(); await p.waitForTimeout(1200);
    assert(await card(p, q1).locator(".mine-take").count() === 1 && /REGRESSION TEST/.test(await card(p, q1).locator(".mine-take").textContent()),
      `the take did not post: ${(await card(p, q1).locator(".err").count()) ? await card(p, q1).locator(".err").textContent() : "no message shown"}`);
    p = await anon.open("/nashville/add/");
    assert(await card(p, q1).locator(".mine-take").count() === 1 && /REGRESSION TEST/.test(await card(p, q1).locator(".mine-take").textContent()), "back on the add page, your take on the question is gone");
    await card(p, q1).locator(".qopt.mine").click(); await p.waitForTimeout(400);
    assert(await card(p, q1).locator(".why-box").count() === 0, "the question asks for a take you already wrote");
    assert(await card(p, q1).locator("[data-same]").count() === 0, "your own take is offered back to you as 'Same as mine'");
  });

  await comesBack(anon, ["votes"], "agreeing with a take already there ('Same as mine') still shows as agreed, without asking again", async () => {
    const other = { id: randomUUID(), city_id: nash.id, question_id: q2.id, type: "take", title: "REGRESSION TEST someone else already said this" };
    await backend.addOtherTake(other);
    try {
      let p = await anon.open("/nashville/add/");
      await card(p, q2).locator(".qopt").first().click(); await p.waitForTimeout(500);
      await card(p, q2).locator(`[data-same="${other.id}"]`).click(); await p.waitForTimeout(600);
      const v = anon.wrote("votes").pop();
      assert(v && v.body.post_id === other.id && v.body.value === 1, "'Same as mine' did not send a True vote");
      p = await anon.open("/nashville/add/");
      assert(await card(p, q2).locator(".mine-take.agreed").count() === 1, "back on the add page, the take you agreed with is no longer shown as agreed");
      assert(await card(p, q2).locator(".why-box").count() === 0, "the question asks again after you agreed with a take");
    } finally { await backend.removeTake(other.id); }
  });

  await comesBack(anon, ["city_tenure"], "how long you've lived in a city is asked once", async () => {
    let p = await anon.open("/nashville/add/");
    assert(await p.locator(".tenure-card").count() === 1, "someone who answered a question should be asked how long they've lived there");
    await p.locator(".tenure-card [data-tenure]").first().click(); await p.waitForTimeout(700);
    p = await anon.open("/nashville/add/");
    assert(await p.locator(".tenure-card").count() === 0, "the add page asks how long you've lived there a second time");
  });

  let votedTake = null;
  await comesBack(anon, ["votes"], "True on a take stays pressed on the city page and on every topic page that shows the take", async () => {
    const withTakes = cities.find(c => livePosts.some(x => x.city_id === c.id));
    assert(withTakes, "no city has an approved take to vote on");
    let p = await anon.open(`/${withTakes.slug}/`);
    const btn = p.locator('.take [data-vote="1"]').first();
    const id = await btn.getAttribute("data-id");
    await btn.click(); await p.waitForTimeout(600);
    assert(anon.wrote("votes").some(w => w.body.post_id === id && w.body.value === 1), "the True vote was not sent");
    votedTake = id;
    p = await anon.open(`/${withTakes.slug}/`);
    assert(await p.locator(`.take [data-vote="1"][data-id="${id}"][aria-pressed="true"]`).count() >= 1, "back on the city page, your True vote is not shown");
    let seen = 0;
    for (const topic of ["what-not-to-do", "worst-times-to-visit", "what-locals-do"]) {
      p = await anon.open(`/${withTakes.slug}/${topic}/`);
      const here = p.locator(`.take [data-vote="1"][data-id="${id}"]`);
      if (!(await here.count())) continue;
      seen++;
      assert((await here.first().getAttribute("aria-pressed")) === "true", `the ${topic} page shows the same take without your True vote`);
    }
    assert(seen >= 1, "the take was not found on any topic page, so the vote was only checked on one page");
  });

  await comesBack(anon, ["vibe_tags"], "a vibe you gave a take still shows as yours", async () => {
    let found = null;
    for (const c of cities.filter(c => livePosts.some(x => x.city_id === c.id))) {
      const p = await anon.open(`/${c.slug}/`);
      if (await p.locator(".take [data-vibe-more]").count()) { found = c; break; }
    }
    assert(found, "no city page has a take that accepts a vibe");
    let p = anon.page;
    const more = p.locator(".take [data-vibe-more]").first();
    const id = await more.getAttribute("data-vibe-more");
    await more.click();
    await p.locator(`[data-vibes-for="${id}"] [data-vibe="first-timer"]`).click(); await p.waitForTimeout(600);
    assert(anon.wrote("vibe_tags").some(w => w.body.post_id === id), "the vibe was not sent");
    p = await anon.open(`/${found.slug}/`);
    assert(await p.locator(`[data-vibes-for="${id}"] [data-vibe="first-timer"][aria-pressed="true"]`).count() >= 1, "back on the city page, the vibe you gave is not shown as yours");
  });

  await comesBack(anon, ["comments"], "a reply you posted on a take is still on its page", async () => {
    const id = livePosts[0].id;
    let p = await anon.open(`/t/${id}`);
    await p.fill("#reply", "REGRESSION TEST still true on weekends");
    await p.click("#send"); await p.waitForTimeout(800);
    assert(anon.wrote("comments").length === 1, "the reply was not sent");
    p = await anon.open(`/t/${id}`);
    assert(/REGRESSION TEST still true on weekends/.test(await p.textContent("#root")), "back on the take's page, your reply is gone");
  });

  await comesBack(anon, ["city_requests"], "a city you asked for stays marked as asked", async () => {
    let p = await anon.open("/cities/");
    await p.evaluate(() => { try { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); navigator.clipboard.writeText = async () => {}; } catch (e) {} });
    const ask = p.locator("#req-list [data-ask]:not([disabled])").first();
    const slug = await ask.getAttribute("data-ask");
    const name = (await ask.locator("xpath=..").locator("b").textContent()).split(",")[0];
    await ask.click(); await p.waitForTimeout(700);
    assert(anon.wrote("city_requests").some(w => w.body.city_slug === slug), "the ask was not sent");
    p = await anon.open("/cities/");
    await p.fill("#req-q", name); await p.waitForTimeout(300);
    const again = p.locator(`#req-list [data-ask="${slug}"]`);
    assert(await again.count() === 1 && await again.isDisabled() && /Asked/.test(await again.textContent()), "back on the cities page, the city you asked for can be asked for again");
  });

  const local = await person({ signedIn: true });
  const TOP3 = ["REGRESSION TEST Uno", "REGRESSION TEST Dos", "REGRESSION TEST Tres"];
  await comesBack(local, ["top3_picks", "restaurants"], "a signed-in person's top 3 restaurants are still theirs, ready to edit", async () => {
    let p = await local.open("/miami/");
    await p.click('[data-tab="eat"]');
    assert(/Add your top 3/.test(await p.textContent("#top3-open")), "a person with no picks should be offered 'Add your top 3'");
    await p.click("#top3-open");
    for (let i = 0; i < 3; i++) await p.fill(`#top3-n${i + 1}`, TOP3[i]);
    await p.click("#top3-save"); await p.waitForTimeout(1500);
    const sent = local.wrote("top3_picks").find(w => w.method === "POST");
    assert(sent && sent.body.length === 3, `the three picks were not saved: ${(await p.locator("#top3 .err").count()) ? await p.textContent("#top3 .err") : "no error shown"}`);
    p = await local.open("/miami/");
    await p.click('[data-tab="eat"]');
    assert(/Edit your top 3/.test(await p.textContent("#top3-open")), "back on the city page, a person who picked a top 3 is asked to add one");
    await p.click("#top3-open");
    for (let i = 0; i < 3; i++) assert((await p.inputValue(`#top3-n${i + 1}`)) === TOP3[i], `pick ${i + 1} did not come back as saved`);
  });

  await test("Coming back never throws a JavaScript error", async () => {
    const all = anon.errors.concat(local.errors);
    assert(!all.length, all.slice(0, 5).join(" | "));
  });

  await test("Every write the pages make has a 'comes back' check, or a stated reason it has nothing to show", async () => {
    const files = (await readdir("assets")).filter(f => f.endsWith(".js")).map(f => join("assets", f))
      .concat((await readdir(".")).filter(f => f.endsWith(".html") && f !== "admin.html"));
    const found = new Map();
    const note = (target, file) => found.set(target, (found.get(target) || new Set()).add(file));
    for (const f of files) {
      const src = await readFile(f, "utf8");
      for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)\s*\.\s*(?:insert|upsert|update|delete)\b/g)) note(m[1], f);
      for (const m of src.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)) note("rpc:" + m[1], f);
      for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/\w+)/g)) note(m[1], f);
    }
    assert(found.size >= 15, `the scan for write paths found only ${found.size}; the pattern no longer matches how pages save`);
    const unlisted = [...found].filter(([t]) => !COMES_BACK.includes(t) && !(t in NOTHING_TO_SHOW));
    assert(!unlisted.length, `new write path with no returning-visitor check: ${unlisted.map(([t, fs]) => `${t} (${[...fs].join(", ")})`).join("; ")}. Add a "Comes back" check in tests/_flows.mjs that does it, leaves, returns and sees it done (then list it in COMES_BACK), or add it to NOTHING_TO_SHOW with the reason`);
    const stale = COMES_BACK.concat(Object.keys(NOTHING_TO_SHOW)).filter(t => !found.has(t));
    assert(!stale.length, `listed here but no page writes it any more: ${stale.join(", ")}. Remove it from the list`);
    const unchecked = COMES_BACK.filter(t => !covered.has(t) && !(["posts", "/api/take"].includes(t) && (covered.has("posts") || covered.has("/api/take"))));
    assert(!unchecked.length, `listed as coming back, but no check above exercised it: ${unchecked.join(", ")}`);
    const unowned = COMES_BACK.filter(t => t !== "/api/take" && !OWNER_COLUMN[t]);
    assert(!unowned.length, `in COMES_BACK without an owner column in OWNER_COLUMN: ${unowned.join(", ")}`);
  });

  return { anon, local, q1, q2, nash, votedTake, WHY, TOP3, close: async () => { await anon.ctx.close(); await local.ctx.close(); } };
}
