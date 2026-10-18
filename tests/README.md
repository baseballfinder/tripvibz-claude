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
| Threads and replies | Split bar, typed "I disagree" reply sent | e2e |
| JavaScript health | No errors on any page visited | e2e |
| City pages exist | Page, vote page and add page for every city in the database | static |
| Facebook previews | Each city's og:image is its 1200×630 question card on www, card file exists | e2e + static |
| Questions | 5 active per city numbered 1–5, 2–4 options each, labels short enough for buttons, database matches `scripts/questions/spec.py` | static |
| Domain | No links to `https://tripvibz.com` (no www), sitemap and robots on www | static |
| Assets | Every `/assets/...` file a page references exists | static |
| Logo | favicon.ico, SVG favicon, app icons, manifest, logo files | static |
| Old UI | No "Cosign", "Add to this article" or "Add my take" anywhere | static |
| Private files | `data/`, `scripts/`, `tests/` are not published | static |
| Tooling | Python scripts compile, workflow files parse | static |

## Not covered automatically (check by hand when they change)

- **Google sign-in completing.** Needs a real Google account; the tests stop at the sign-in box.
  After a sign-in change: sign in on the preview link and post one take with the Local badge.
- **Facebook's actual preview.** After a share-card change, paste a city link into
  developers.facebook.com/tools/debug and click Scrape Again.
- **Email (Kit) and the city-request issue.** Run Actions → City requests → Run workflow
  and confirm no error; an issue only appears when a city has 5 asks.
- **Nightly backup.** Check Actions → Nightly database backup shows green.
- **Database rules** (rate limits, verified badges, claims). Changed only by SQL migrations;
  re-test with a rolled-back transaction before running a migration.
