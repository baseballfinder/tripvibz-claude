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
  clicks; `regression.mjs` for the two site-wide rules below; `security.mjs`
  for headers, input handling and workflows; `perf.mjs` for size budgets;
  `schema.mjs` for structured data; `db-security.sql` for database policies. A bug fix gets a test that fails without the fix.
- **A real exception** (a pure refactor, a style-only edit inside an app page,
  copy inside a script): add the `no-tests-needed` label and say why in the
  pull-request description. Don't use it for new behavior.

Before opening a PR, run the suites locally (first time:
`npm ci && npx playwright install chromium`):

```
node build.mjs && node tests/static.mjs && node tests/security.mjs && node tests/perf.mjs \
  && node tests/schema.mjs && node tests/e2e.mjs && node tests/regression.mjs && node tests/csp.mjs
git diff --name-only origin/main...HEAD | node scripts/tests-included.mjs
```

## Two rules every feature keeps (`tests/regression.mjs`)

Both came from bugs that passed every other test (Nov 2026). The suite checks
them across the whole site, so a feature that breaks one fails the build.

- **A page's script keeps what the build wrote.** `build.mjs` writes the search
  title, description, headline, structured data and the pre-rendered blocks
  (`id="tv-…"`). Google runs the script too, so a script may add to the page
  but must not replace or remove those. Every page in `dist/` is compared with
  its script off and on. A deliberate exception goes in `ALLOWED_CHANGES` with
  its reason.
- **What a person did is still there when they come back.** If a page lets
  someone answer, vote, post, pick or ask, the same page (and any other page
  that shows it) must show it as done on their next visit, and must not ask
  again. A new write (a new `.from("…").insert/upsert/update/delete`, `.rpc()`
  or `/api/…` call in a page) fails the suite until it has a "Comes back" check
  there, or a line in `NOTHING_TO_SHOW` saying why there is nothing to show.

Not checked automatically, same idea: **a change to how something is stored
brings the old rows along.** When a feature starts reading a new column or
table (as the add page did with `question_id`), the same pull request carries
a migration that fills it in for existing rows, so what people already did
keeps showing.

## Keep the info pages current

When a feature is added, changed or removed, update what the site says about
it in the same pull request:

- **About** (`about/index.html`): how it works, one line per main feature.
- **Privacy** (`privacy/index.html`): anything new that's stored, shown publicly,
  or sent to an outside service; update its "Last updated" date.
- **Terms**, **How we verify locals**, and the copy inside the pages (empty
  states, sign-in prompts, share images from `scripts/og_cards.py`).
- **Retired wording** goes everywhere at once, including share images and the
  structured data in `build.mjs`.

`tests/static.mjs` ("Info pages follow the features") enforces the parts it
can: Privacy must name every outside service the site loads or calls and
every table that stores what people enter; retired wording fails the build;
About must list the main features (add yours to its list).

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
