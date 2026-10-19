# TripVibz test plan

Runs automatically on every pull request and every merge to `main`
(`.github/workflows/tests.yml`). A red check on a pull request means: don't merge.

Both suites read the live Supabase data, so they test the real cities, questions
and takes. **They never write to it**: the browser tests intercept every post,
vote, reply, city request and anonymous sign-in and answer them locally.

Run locally: `node build.mjs && node tests/static.mjs && node tests/e2e.mjs`
(first time: `npm ci && npx playwright install chromium`). To test a Cloudflare
preview instead of the local build: `BASE=https://<branch>.tripvibz.pages.dev node tests/e2e.mjs`.

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
| Tooling | Python scripts compile, workflow files parse | static |

## Not covered automatically (check by hand when they change)

- **Google sign-in completing.** Needs a real Google account; the tests stop at the sign-in box.
  After a sign-in change: sign in on the preview link and post one take with the Local badge.
- **Facebook / TikTok sign-in completing.** Needs the Meta and TikTok apps set up; after switching one on, sign in on the preview link and post one take.
- **Facebook's actual preview.** After a share-card change, paste a city link into
  developers.facebook.com/tools/debug and click Scrape Again.
- **Phone share sheet.** On phones the Share button opens the system share sheet instead of the menu;
  the tests run as a desktop browser. After a sharing change, tap Share on a take on your phone.
- **Email (Kit) and the city-request issue.** Run Actions → City requests → Run workflow
  and confirm no error; an issue only appears when a city has 5 asks.
- **Nightly backup.** Check Actions → Nightly database backup shows green.
- **Database rules** (rate limits, verified badges, claims). Changed only by SQL migrations;
  re-test with a rolled-back transaction before running a migration.
