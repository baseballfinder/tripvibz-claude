# TripVibz: rules for working in this repo

TripVibz (www.tripvibz.com) is a static site built by `build.mjs` from the live
Supabase database and served by Cloudflare Pages, with Pages Functions in
`functions/`. Changes go in as pull requests; `main` deploys automatically.

## New code comes with tests

Every pull request that adds or changes what the site does must add or update
a test for it, in the same pull request. This is checked automatically: the
**Tests included** check (`.github/workflows/tests-required.yml`, rule in
`scripts/tests-included.mjs`) fails a PR that changes site code without
changing a test.

- **Site code:** the app pages at the root (`index.html`, `city.html`, `add.html`…),
  `assets/*.js`, `build.mjs`, `lib/`, `functions/`, `supabase/migrations/`,
  and the scripts in `scripts/`.
- **Doesn't need a test:** the wording pages in folders (`about/`, `privacy/`…),
  `data/`, images, styles (`*.css`), docs, workflows, dependency files, and
  `supabase/schema.sql`.
- **A new feature** also gets a row in the "Features and what covers them" table
  in `tests/README.md`. The table is documentation; it doesn't count as a test.
- **Pick the suite that fits** (`tests/README.md` lists them): `static.mjs` for
  build output, data rules and pure functions; `e2e.mjs` for anything a person
  clicks; `security.mjs` for headers, input handling and workflows; `perf.mjs`
  for size budgets; `schema.mjs` for structured data; `db-security.sql` for
  database policies. A bug fix gets a test that fails without the fix.
- **A real exception** (a pure refactor, a style-only edit inside an app page,
  copy inside a script): add the `no-tests-needed` label and say why in the
  pull-request description. Don't use it for new behavior.

Before opening a PR, run the suites locally (first time:
`npm ci && npx playwright install chromium`):

```
node build.mjs && node tests/static.mjs && node tests/security.mjs && node tests/perf.mjs \
  && node tests/schema.mjs && node tests/e2e.mjs && node tests/csp.mjs
git diff --name-only origin/main...HEAD | node scripts/tests-included.mjs
```

## How to build it

Read `docs/ARCHITECTURE.md` before adding a feature that touches the server,
the database or a background job. In short:

- **One codebase, clear modules.** Don't split into separate services until a
  piece needs to scale or deploy on its own.
- **Loose coupling.** Shared things live in one module (config, headers,
  database calls); import them rather than copying.
- **Stateless Functions.** Nothing that matters lives in a Function's memory.
- **Cache first.** Prefer pre-rendering and the edge cache over new
  infrastructure. Add Redis, queues, replicas or containers only at the
  triggers the doc gives.
- **Design for failure.** Every outside call has a time limit and a chosen
  failure mode (fail open for nice-to-haves, closed for writes and security).
- **Slow work runs in the background** (scheduled jobs), never in a visitor's
  request.

## Other rules

- **Tests never write to the live database.** `tests/e2e.mjs` intercepts every
  post, vote and request; a new write path needs a matching intercept there.
- **Database changes are migrations** in `supabase/migrations/`
  (`YYYYMMDDHHMMSS_name.sql`), applied by the Supabase GitHub integration on
  merge. A merge that adds one puts the "Back in a few minutes" cover over the
  site until it has applied (`.github/workflows/maintenance-cover.yml`).
- **Generated files:** `functions/_inline-hashes.js` is rewritten by
  `node build.mjs`; commit it with the page change. Don't edit
  `supabase/schema.sql` by hand.
- **Size budgets are real:** city pages must stay under 72 KB
  (`tests/perf.mjs`); content growth counts.
