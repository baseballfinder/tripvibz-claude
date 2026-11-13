# TripVibz test plan

Runs automatically on every pull request and every merge to `main`
(`.github/workflows/tests.yml`). A red check on a pull request means: don't merge.

Both suites read the live Supabase data, so they test the real cities, questions
and takes. **They never write to it**: the browser tests intercept every post,
vote, reply, city request and anonymous sign-in and answer them locally.

Run locally: `node build.mjs && node tests/static.mjs && node tests/security.mjs && node tests/perf.mjs && node tests/schema.mjs && node tests/e2e.mjs && node tests/regression.mjs && node tests/csp.mjs`
(first time: `npm ci && npx playwright install chromium`). To test a Cloudflare
preview instead of the local build: `BASE=https://<branch>.tripvibz.pages.dev node tests/e2e.mjs`
(same for `tests/csp.mjs`, which on a preview also exercises GA4, Clarity and the Stay22 map).
Lighthouse: `npx lhci autorun` (desktop) and `npx lhci autorun --config=lighthouserc.mobile.json` (mobile); needs Chrome; reports land in `.lighthouseci/`.
The database lint needs the database URL: `psql "$SUPABASE_DB_URL" -f tests/db-security.sql`.

## Suites

| Suite | What | Needs |
|---|---|---|
| `static.mjs` | Pages, links, share cards, questions, sitemap, private files, migration names | build |
| `security.mjs` | Security headers + CSP (one source: `functions/_security.js`), no third-party scripts, no secrets in the repo, workflow hygiene, API input rejection, open-redirect guard, SECURITY DEFINER search_path | build |
| `perf.mjs` | Size budgets: pages, scripts, styles, fonts, share images, lazy-loaded grid photos, sitemap size; analytics deferred and held until first touch/scroll/key or 5 s after load, no external render-blocking requests | build |
| `schema.mjs` | Structured data: every type/property is real schema.org (live vocabulary) and allowed on its type, `@id` references resolve on the same page, Google's required fields for Article / Breadcrumb / ItemList / DiscussionForumPosting / Organization / WebSite, canonical matches; also renders `/t/<id>` for a real take | build (+ network for the vocabulary) |
| `e2e.mjs` | Every feature in a real browser, writes intercepted | build + Chromium |
| `csp.mjs` | Every page type loads with the Content-Security-Policy enforced, no violations | build + Chromium |
| `regression.mjs` | Two site-wide rules a new or changed feature must not break: page scripts keep what the build wrote (every page in `dist/`, script off vs. on), and what a visitor did is still there when they come back (the flows in `_flows.mjs`, saved to an in-memory copy) | build + Chromium |
| `database.mjs` | The same visitor flows against a throwaway copy of the real database, built from `supabase/schema.sql` plus the migrations after it: every save goes through the real permissions, triggers and limits and is read back | build + Chromium + Postgres/PostGIS + PostgREST |
| `lighthouserc.json` | Lighthouse, desktop: performance ≥ 85, accessibility/best-practices/SEO ≥ 90, LCP ≤ 4 s, CLS ≤ 0.1, TBT ≤ 300 ms, zero contrast failures, render-blocking ≤ 250 ms, resource budgets on 5 page types | build + Chrome |
| `lighthouserc.mobile.json` | Lighthouse, mobile (PageSpeed's phone emulation): performance ≥ 85, LCP ≤ 3.5 s, FCP ≤ 2 s, TBT ≤ 300 ms, CLS ≤ 0.1, responsive images, LCP image preloaded and not lazy, on the Fort Lauderdale, home and a topic page | build + Chrome |
| `db-security.sql` | Read-only database lint: RLS everywhere, no open write policies, SECURITY DEFINER allow-list and search_path, tamper guards from migration 20261029174500 | `SUPABASE_DB_URL` |
| `npm audit` (workflow step) | Dependencies with high/critical advisories | — |

## Features and what covers them

| Feature | Automated check | Suite |
|---|---|---|
| Homepage | Headline, every city in the grid, logo, "Ask for your city" link, favicon | e2e |
| Cities page | Grid, search (incl. no-match message) | e2e |
| City search | 16px box (no iPhone zoom), states by name ("Florida"), nicknames (NYC, Philly), Saint/St., typos ("Ashville"), ranked suggestions with Enter and a clear button, ask for a city from the list, quick picks (near you, recently viewed, states); `/api/near` returns only a rounded position and is never cached | e2e + static |
| Request a city | Search finds Tulsa, tapping "Ask for it" sends the request and flips to "Asked" | e2e |
| City feed | Hero photo loads, lead question = first active question, options, four tabs (Takes · Eat · When to go · Guide) with one panel shown and the hash deep-linking a tab, section chips only at 10+ takes, Add-your-take bar (Nashville, Knoxville, Miami) | e2e |
| One-tap voting on questions | Vote link records the vote, results and "Why?" box show | e2e |
| Posting a take (anonymous) | Kind, starter, place (typed, no pin), month, tenure, preview, posted page, 1080×1920 share card | e2e |
| Add page = the city's questions | Every active question as a card with its options; one tap records the answer (`question_votes`) and opens an optional "Say why" box; a sentence posts a take tied to the question (`question_id`, title = answer + sentence) and the card then shows it; "Just the answer is fine" closes the box; optional place search in the why box; progress counter; `?kind=` from a topic page orders matching questions first; "Something we didn't ask about?" sends a suggested question for review (pending take with a topic); anonymous visitors get a quiet sign-in nudge. No free-text composer on the page — it survives only for admin reply links (`/add/?text=`) | e2e |
| Answer links (email buttons) | `/<city>/add/?q=<question id>&a=<option id>` saves that answer once as if tapped, puts the question first with its why box open, and drops `q`/`a` from the address so a refresh doesn't answer again; an answer the person already gave is never overwritten; an unknown option saves nothing | e2e |
| Already said (add page) | After you answer, the question's approved takes from other people show above the why box ("Already said · N", 3 shown); "Same as mine" sends a True vote on that take instead of a new post and the card shows "You agreed with"; your own takes (any browser you're signed in on) show as "Your take"; the sign-in nudge says answers follow you across devices; migration 20261112180000 links the takes posted before preset questions to the question they answer | e2e |
| Where is this? (custom take via admin reply link, and the why box) | 16px search over spots, neighborhoods and restaurants (`search_take_places`); a catalogue pick is copied in server-side (`ensure_spot_from_place`, intercepted) and pins the take; a TripVibz spot goes straight on the take; "Change" clears it; a name with no match posts as typed without a pin | e2e |
| Catalogue city limits | `data/city-localities.json`: `only` keeps islands and water-bound cities to their own address localities (Miami Beach; Key West + Stock Island; New York's five boroughs incl. Queens' postal names; San Francisco; Seattle), `also` lets Miami claim its barrier-island towns, `exclude` keeps a destination across the bay or county line out (Tampa ↛ St. Petersburg, Sarasota ↛ Bradenton, Fort Lauderdale ↛ Boca Raton, Fort Myers ↛ Lehigh Acres); other cities take the nearest place within the radius; nothing outside the US; a re-run drops rows it no longer writes for a city. Checked on real coordinates through the loader's `assign_city` | static |
| Guide tab | Replaces Stay (old `#stay` links open it). Its script, the map library and the tiles load only when it opens; map pins for the top restaurants and the take spots; top 3 with "Picked by N people", verified count and reviews (verified first, blanks skipped); spots with their takes; hotels last; tapping a pin opens its card; no sideways scroll; if the map fails the lists stand. Rules and markup (`assets/guide.js`, shared with the build): grouping, ranking, escaping, empty states; Leaflet pinned and never named in a page; spot loader keeps one copy per name (the medoid, not the inland outlier) and drops apartment blocks; `db-security.sql` rule 7 (no session-less copies, spot must be in the take's city, restaurant search stays food-only) | e2e + static + csp + perf + db-security |
| Sign in with Google (Local badge) | Badge button opens the sign-in box | e2e |
| Topic pages | Headline, 3 tabs, starters open the add page, old Cosign UI gone, 12-month calendar on Worst times | e2e |
| Weather by month (worst-times pages) | NOAA 1991–2020 normals for every city in `data/climate/normals.json` (12 sane months), table pre-rendered with 12 rows matching the data, labeled NOAA averages / not a forecast, between calendar and takes, kept after hydration, absent on other topics | static + e2e |
| True / Nope on takes | Toggle on, vote sent | e2e |
| Sharing | Share button on every take card, share menu (copy, text, WhatsApp, Facebook, X, email) all carry the take's www /t/ link, thread "Do your friends agree?" share, "Ask your friends" after voting on a question | e2e |
| New topics (review queue) | City page "Something we didn't ask about?" box sends the take with its topic and shows the thank-you state | e2e |
| Sign-in options | Facebook + TikTok buttons appear (with ?preview=signin until set up), TikTok button goes to the sign-in bridge, return messages clear from the address; privacy and terms pages exist; bridge checks its state cookie | e2e + static |
| Phone notifications | Search-visit notifier and new-take notifier present and valid; the search beacon never fires on localhost | static |
| Cover page during database updates | Page loads get the 503 "Back in a few minutes" page while `site_status` is on; the API, assets, admin, non-HTML requests and `?preview=live` never do; an expired or unreadable switch serves the real site; `/assets/*` skips Functions; the workflow runs only on migration merges and always switches off | static |
| Vibes | Custom take (admin reply link): up to two vibes on "Do this" takes, none on warnings, saved with the take; take cards take a vibe in one tap; the vibe list in `assets/v2.js` matches the migration; database refuses vibes on warnings and timing, more than two per person per item, and edits; vibe pages (`/<city>/<vibe>/`) exist from 1 entry and are indexed from 3 | e2e + static |
| New code comes with tests | The "Tests included" check fails a PR that changes site code without a test; the rule (`scripts/tests-included.mjs`) is checked against real past PRs; only the `no-tests-needed` label skips it; `CLAUDE.md` states it and isn't published | static + workflow |
| Info pages follow the features | Privacy names every outside service (from the CSP and `functions/`) and every table that stores what people enter, and is dated after the newest such table; no retired wording on any page, script or share image; About lists the main features | static |
| Threads and replies | Split bar, typed "I disagree" reply sent | e2e |
| JavaScript health | No errors on any page visited | e2e |
| Scripts keep what the build wrote (site-wide) | Every page in `dist/` is loaded with its script off and on: robots, canonical and share tags match on all pages; search title, description, headline, structured data match on indexed pages; no pre-rendered heading or `id="tv-…"` block is removed or doubled. New pages are picked up automatically; a deliberate exception goes in `ALLOWED_CHANGES` with its reason | regression |
| What you did comes back (site-wide) | A visitor does each thing, leaves, and returns as the same person: answered question (add page shows it, progress counts it, city page moves to the next question), a take written on a question, "Same as mine", how long you've lived there (asked once), True on a take (city page and topic pages), a vibe on a take, a reply, a city request, a signed-in person's top 3. Writes go to an in-memory copy of the tables. The suite scans the pages for every write (`.from(…).insert/upsert/update/delete`, `.rpc(…)`, `/api/…`) and fails on one that is in neither `COMES_BACK` nor `NOTHING_TO_SHOW` | regression + database |
| Input really reaches the database | A test database is built from the repo (schema snapshot + every later migration, so a migration in the pull request is tried before it reaches the live site; one that doesn't apply fails here). The visitor flows then save to it through PostgREST and the real `/api/take` Function: no save and no read may be refused; the answer, take, reply, votes and top 3 are read back from the tables (right question, city, owner, words; True and reply counts go up by one); and the database still refuses saving as someone else, saving while signed out, and an anonymous top 3 | database |
| City pages exist | Page, vote page and add page for every city in the database | static |
| Facebook previews | Every page type points at its own 1200×630 card on www (home, cities, city question, topic pages, post page), the shared-take card exists for every city, and the /t/<id> preview function is present | e2e + static |
| Questions | 5 active per city numbered 1–5, 2–4 options each, labels short enough for buttons, database matches `scripts/questions/spec.py` | static |
| Domain | No links to `https://tripvibz.com` (no www), sitemap and robots on www | static |
| Assets | Every `/assets/...` file a page references exists | static |
| Logo | favicon.ico, SVG favicon, app icons, manifest, logo files | static |
| Installable (PWA) | Manifest fields and icons (incl. a maskable one), `sw.js` carries the build id and every precached file exists, `/sw.js` served no-cache, offline page noindex, `pwa.js` on every page, home-screen metas; CSP lets the worker run; in a browser: worker registers and saves the shell, a visited city page opens offline, unvisited pages get the offline page, the home-screen offer shows on the second visit (iOS wording) and stays dismissed, never in standalone | static, security, e2e |
| Old UI | No "Cosign", "Add to this article", "Add my take" or "Back to feed" anywhere; no old add button on city pages | static |
| Private files | `data/`, `scripts/`, `tests/` are not published | static |
| Security headers | CSP, HSTS, frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy in `_headers` and on Function HTML | security |
| Supply chain | No third-party `<script>` (Supabase client bundled from the pinned package), no secrets committed, `npm audit` | security + workflow |
| API hardening | `/api/take` rejects oversize/malformed input, `/api/hit` ignores bots, TikTok bridge rejects bad state and open redirects | security |
| Database rules | RLS on every table, no open write policies, authors can't edit counts/status/badges, visitor calendar entries wait for review, trigger functions can't be called through the API | db-security.sql + database |
| Speed | Lighthouse scores and Core Web Vitals; render-blocking ≤ 250 ms; file-size budgets | lighthouse + perf |
| Accessibility | Lighthouse accessibility ≥ 90 and zero colour-contrast failures, valid ARIA | lighthouse |
| Structured data | Valid, self-contained schema.org on every page type | schema |
| Tooling | Python scripts compile, workflow files parse | static |

## Database round trip (`tests/database.mjs`)

Every other browser test answers a save with a pretend "saved". This one builds a real database from
the repo and lets the pages save to it, so a migration that renames a column, drops a grant, tightens
a policy or changes a limit fails here instead of on the live site.

- **What it builds** (`tests/db/start.mjs`): a new database on a local Postgres, then
  `tests/db/supabase-shim.sql` (the Supabase roles, `auth.uid()`/`auth.jwt()` and extensions the schema
  assumes), `supabase/schema.sql`, and every file in `supabase/migrations/` newer than the snapshot's
  "Includes migrations through" line. PostgREST, the server Supabase runs in front of Postgres, sits in
  front of it. The database is dropped at the end. It will only build on `127.0.0.1`/`localhost` or the
  CI service; it never connects to the live project.
- **What is real:** the built pages, PostgREST, every table, policy, trigger and function, and the
  `/api/take` Function. **What is not:** sign-in itself (the test hands the browser a session signed with
  that run's key) and Cloudflare's location stamp. Public reference data (cities, questions, approved
  takes, places, events, restaurants) is copied from the live site's public API at the start so the built
  pages find the ids they were built with.
- **When the snapshot is refreshed** (the weekly "Schema snapshot" pull request), its header line moves
  forward and fewer migrations are replayed. If the test database ever stops matching the live one,
  refresh the snapshot first.
- **Run it locally:** needs Docker or a local Postgres with PostGIS, plus `psql` and
  [PostgREST](https://github.com/PostgREST/postgrest/releases) on the PATH (or `POSTGREST_BIN`):

  ```
  docker run -d --name tv-test-db -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgis/postgis:17-3.5
  node build.mjs && node tests/database.mjs
  ```

  It looks for Postgres on 127.0.0.1:5432 with user and password `postgres` (what that command starts);
  `TEST_PG_URL` points it elsewhere on the same machine. Without a database, run the other suites as
  usual; CI always runs this one.

## Not covered automatically (check by hand when they change)

- **Google sign-in completing.** Needs a real Google account; the tests stop at the sign-in box.
  After a sign-in change: sign in on the preview link and post one take with the Local badge.
- **Facebook / TikTok sign-in completing.** Needs the Meta and TikTok apps set up; after switching one on, sign in on the preview link and post one take.
- **Facebook's actual preview.** After a share-card change, paste a city link into
  developers.facebook.com/tools/debug and click Scrape Again.
- **Phone share sheet.** On phones the Share button opens the system share sheet instead of the menu;
  the tests run as a desktop browser. After a sharing change, tap Share on a take on your phone.
- **Phone notifications (ntfy).** After a change to `functions/api/_notify.js`, `hit.js`, `take.js`, `event.js` or `error.js`: open a TripVibz page from a Google result, post a test take and add a calendar entry; all should reach the ntfy app. Site errors (browser or Function) arrive the same way, priority low.
- **Uptime.** Point an uptime monitor (UptimeRobot, Better Stack, …) at `https://www.tripvibz.com/api/health` — 200 when site and database answer, 503 when the database doesn't.
- **Anonymous sessions.** A page view creates no account; the first vote/take/reply/ask/signup does. `.github/workflows/maintenance.yml` removes empty anonymous users after 30 days (nightly, summary on the run page).
- **Email (Kit) and the city-request issue.** Run Actions → City requests → Run workflow
  and confirm no error; an issue only appears when a city has 5 asks.
- **Nightly backup.** Check Actions → Nightly database backup shows green.
- **Database rules** (rate limits, verified badges, claims). Changed only by SQL migrations;
  re-test with a rolled-back transaction before running a migration. `tests/db-security.sql`
  checks the rules exist; it does not exercise them as a user.
- **Lighthouse on the live site.** CI measures the local build (same HTML, same assets) with
  GA4/Clarity/Stay22 off. Check PageSpeed Insights on www after a change to third-party scripts.

## Photos

City photos live in Supabase storage (`city-photos/<slug>.webp`, 800×500). `build.mjs` downloads each
one and writes resized WebP copies to `dist/assets/city/`: `<slug>-{256,360,480,640,720,800}.webp` and
8:3 crops `<slug>-short-{720,800}.webp` for topic-page heroes. Pages reference these with `srcset`/`sizes`
measured from the real layout (grid tiles 171–256 CSS px on desktop and full/half width on phones;
heroes 608 px on desktop and 650–720 device px on phones). The hero is pre-rendered in the HTML with
`fetchpriority="high"` and a `<link rel="preload">`, and kept across hydration (`id="tv-hero"`).
The home and `/cities/` grids are pre-rendered in the same markup and order the page scripts produce,
with the first two tiles at `fetchpriority="high"`; the scripts then refresh counts in place and mark the
grid `data-hydrated="inplace"` (e2e asserts it). Rebuilding the grid moved different photos into view a
second time, and that late paint — not the hero — was the page's LCP (~3.5 s on a phone in CI).

## Local verification

Three badge tiers, drawn by `assets/v2.js localBadge()` and mirrored in the `/t/<id>` Function:
✓ Verified local (presence near the city on several days over weeks), Local · unverified (signed in,
says they're local), Unverified (anonymous or revoked). `functions/api/locate.js` reads Cloudflare's
rough location once a day per signed-in person and after every take, and records it through the
database function `record_presence` (migration `20261030120000_local_presence.sql`), which counts
distinct days near the city; the trigger `trg_local_checks_verified` computes `local_checks.verified`
from `tv_local_verified()` — the thresholds live there and nowhere else. Checks from hosting/VPN
networks (`functions/api/_networks.js`) are stored as band `hosting` and never count. The public reads
only `verified`/`revoked`; the day counts are admin-only (`admin_local_checks`). Founding local needs
the ✓. The public explanation is `/how-we-verify-locals/`; the static test checks it describes the
method but not the exact numbers, and `tests/db-security.sql` checks the grants and the trigger.

## Guide tab and take spots

Migration `20261107170000_guide_spots.sql`. `places_catalog.kind` splits the Overture catalogue into
`eat` (the restaurant picker; `search_places()` now filters to it) and `spot`: parks, beaches,
landmarks, museums, stadiums, plazas and the neighborhoods notable enough to have a Wikidata entry,
loaded by the same monthly `scripts/places_catalog.py` run (one copy per name, the one nearest the rest
of its group). A take points at `public.places` through `posts.place_id`; a catalogue spot is copied
there only when a take uses it (`ensure_spot_from_place()`, security definer, any session but not
session-less visitors), and `posts_sync_city` refuses a spot from another city. `search_take_places()`
feeds "Where is this?" on the add page: TripVibz's own spots first (with their take counts), then
catalogue spots, then restaurants and bars. The migration pins the seven live takes that name one spot
(checked against Overture on Nov 7 2026). The Guide panel is drawn by `assets/guide.js` (the build
runs the same file to pre-render it) and loaded with Leaflet and OpenStreetMap tiles only when the tab
opens; the e2e test answers the pins as a migrated database would, so it passes before and after the
migration lands.

## Locals' top 3 restaurants

Migration `20261030140000_top3_restaurants.sql`: `places_catalog` (eat-and-drink places within ~25 km of
each city from Overture Maps' open places data, CDLA-Permissive 2.0; loaded monthly by
`.github/workflows/places-catalog.yml` → `scripts/places_catalog.py` with DuckDB, bot role; searched by
`search_places()` with pg_trgm fuzzy matching), `restaurants` (one row per place per city; a catalogue
pick is created server-side by `ensure_restaurant_from_place()` with address/phone/website/coordinates
copied from the catalogue, hand-typed names get `source = 'local'` and fold spelling via `name_key`;
admins hide/rename/merge in admin.html) and `top3_picks` (one ranked list per signed-in person per
city, optional one-line why). Each place on the page gets Directions (Google Maps URL, no API),
Call, Website and a Stay22 "Hotels near" link (campaign `tripvibz_top3_<city>`).
Anonymous sessions can't write either (`jwt_is_verified()`); names and whys go through the same
content screen as takes; a person can add at most 10 new restaurant rows a day. The
`city_top_restaurants` view rolls picks up (#1 = 3 points, #2 = 2, #3 = 1) with verified locals'
points first; `build.mjs eatsHtml` pre-renders it on every city page and `city.html` refreshes it in
place, then shows the picker to signed-in people. The e2e test drives the picker with a fake
signed-in session and checks the writes (restaurants with `created_by`, list cleared then inserted as
ranks 1–3); the static test checks the section, the RLS conditions and the rate limit.

## Content-Security-Policy

`script-src` has no `'unsafe-inline'`. `build.mjs` hashes every inline `<script>` as it emits a page
(one per page template, plus one small head script that handles photo fallbacks) and writes the list to
`functions/_inline-hashes.js`, which `functions/_security.js` reads for both `dist/_headers` and the
Functions that render HTML. The generated file is committed; the security test fails when it is stale
("run `node build.mjs` and commit it"). Inline `on*=` handlers are not allowed at all: images carry
`data-fallback` (swap to the Supabase original) or `data-err="remove|hide"`, handled by that head script
(e2e tests it). `tests/csp.mjs` loads every page type with the policy enforced, so a new inline script
that isn't in the list shows up there first.

## Scripts

`/assets/supabase.js` is bundled by `build.mjs` from `lib/supabase-client.mjs`: the PostgREST and Auth
packages only (30 KB gzipped), wired the way `@supabase/supabase-js` wires them, without the Realtime,
Storage and Functions clients the pages never call (the full package was 57 KB gzipped). The security
test checks that those never creep back in; the perf budget is 140 KB raw.
If a photo can't be downloaded at build time the page falls back to the Supabase URL. When a photo
changes in storage, the next build picks it up; no cache to clear.
