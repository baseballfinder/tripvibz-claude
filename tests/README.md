# TripVibz test plan

Runs automatically on every pull request and every merge to `main`
(`.github/workflows/tests.yml`). A red check on a pull request means: don't merge.

Both suites read the live Supabase data, so they test the real cities, questions
and takes. **They never write to it**: the browser tests intercept every post,
vote, reply, city request and anonymous sign-in and answer them locally.

Run locally: `node build.mjs && node tests/static.mjs && node tests/security.mjs && node tests/perf.mjs && node tests/schema.mjs && node tests/e2e.mjs && node tests/csp.mjs`
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
| `perf.mjs` | Size budgets: pages, scripts, styles, fonts, share images, lazy-loaded grid photos, sitemap size; analytics deferred, no external render-blocking requests | build |
| `schema.mjs` | Structured data: every type/property is real schema.org (live vocabulary) and allowed on its type, `@id` references resolve on the same page, Google's required fields for Article / Breadcrumb / ItemList / DiscussionForumPosting / Organization / WebSite, canonical matches; also renders `/t/<id>` for a real take | build (+ network for the vocabulary) |
| `e2e.mjs` | Every feature in a real browser, writes intercepted | build + Chromium |
| `csp.mjs` | Every page type loads with the Content-Security-Policy enforced, no violations | build + Chromium |
| `lighthouserc.json` | Lighthouse, desktop: performance ≥ 85, accessibility/best-practices/SEO ≥ 90, LCP ≤ 4 s, CLS ≤ 0.1, TBT ≤ 300 ms, zero contrast failures, render-blocking ≤ 250 ms, resource budgets on 5 page types | build + Chrome |
| `lighthouserc.mobile.json` | Lighthouse, mobile (PageSpeed's phone emulation): performance ≥ 85, LCP ≤ 3.5 s, FCP ≤ 2 s, TBT ≤ 300 ms, CLS ≤ 0.1, responsive images, LCP image preloaded and not lazy, on the Fort Lauderdale, home and a topic page | build + Chrome |
| `db-security.sql` | Read-only database lint: RLS everywhere, no open write policies, SECURITY DEFINER allow-list and search_path, tamper guards from migration 20261029174500 | `SUPABASE_DB_URL` |
| `npm audit` (workflow step) | Dependencies with high/critical advisories | — |

## Features and what covers them

| Feature | Automated check | Suite |
|---|---|---|
| Homepage | Headline, every city in the grid, logo, "Ask for your city" link, favicon | e2e |
| Cities page | Grid, search (incl. no-match message) | e2e |
| Request a city | Search finds Tulsa, tapping "Ask for it" sends the request and flips to "Asked" | e2e |
| City feed | Hero photo loads, lead question = first active question, options, section chips, add button (Nashville, Knoxville, Miami) | e2e |
| One-tap voting on questions | Vote link records the vote, results and "Why?" box show | e2e |
| Posting a take (anonymous) | Kind, starter, place, month, tenure, preview, posted page, 1080×1920 share card | e2e |
| Sign in with Google (Local badge) | Badge button opens the sign-in box | e2e |
| Topic pages | Headline, 3 tabs, starters open the add page, old Cosign UI gone, 12-month calendar on Worst times | e2e |
| True / Nope on takes | Toggle on, vote sent | e2e |
| Sharing | Share button on every take card, share menu (copy, text, WhatsApp, Facebook, X, email) all carry the take's www /t/ link, thread "Do your friends agree?" share, "Ask your friends" after voting on a question | e2e |
| New topics (review queue) | City page "Something we didn't ask about?" box sends the take with its topic and shows the thank-you state | e2e |
| Sign-in options | Facebook + TikTok buttons appear (with ?preview=signin until set up), TikTok button goes to the sign-in bridge, return messages clear from the address; privacy and terms pages exist; bridge checks its state cookie | e2e + static |
| Phone notifications | Search-visit notifier and new-take notifier present and valid; the search beacon never fires on localhost | static |
| Threads and replies | Split bar, typed "I disagree" reply sent | e2e |
| JavaScript health | No errors on any page visited | e2e |
| City pages exist | Page, vote page and add page for every city in the database | static |
| Facebook previews | Every page type points at its own 1200×630 card on www (home, cities, city question, topic pages, post page), the shared-take card exists for every city, and the /t/<id> preview function is present | e2e + static |
| Questions | 5 active per city numbered 1–5, 2–4 options each, labels short enough for buttons, database matches `scripts/questions/spec.py` | static |
| Domain | No links to `https://tripvibz.com` (no www), sitemap and robots on www | static |
| Assets | Every `/assets/...` file a page references exists | static |
| Logo | favicon.ico, SVG favicon, app icons, manifest, logo files | static |
| Old UI | No "Cosign", "Add to this article", "Add my take" or "Back to feed" anywhere; no old add button on city pages | static |
| Private files | `data/`, `scripts/`, `tests/` are not published | static |
| Security headers | CSP, HSTS, frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy in `_headers` and on Function HTML | security |
| Supply chain | No third-party `<script>` (Supabase client bundled from the pinned package), no secrets committed, `npm audit` | security + workflow |
| API hardening | `/api/take` rejects oversize/malformed input, `/api/hit` ignores bots, TikTok bridge rejects bad state and open redirects | security |
| Database rules | RLS on every table, no open write policies, authors can't edit counts/status/badges, visitor calendar entries wait for review | db-security.sql |
| Speed | Lighthouse scores and Core Web Vitals; render-blocking ≤ 250 ms; file-size budgets | lighthouse + perf |
| Accessibility | Lighthouse accessibility ≥ 90 and zero colour-contrast failures, valid ARIA | lighthouse |
| Structured data | Valid, self-contained schema.org on every page type | schema |
| Tooling | Python scripts compile, workflow files parse | static |

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

## Locals' top 3 restaurants

Migration `20261030140000_top3_restaurants.sql`: `restaurants` (one row per place per city; `name_key`
folds spelling so "The Salty Donut" and "salty donut" are one row; admins hide/rename/merge in
admin.html) and `top3_picks` (one ranked list per signed-in person per city, optional one-line why).
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
