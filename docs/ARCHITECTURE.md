# TripVibz architecture rules

How to build TripVibz so it keeps working as traffic and data grow. Each rule
says what it means here, what the site already does, and when the
heavier version of the idea becomes worth its cost. **Don't add the heavier
version before its trigger**: at today's size, extra moving parts cost more
in outages and upkeep than they save.

**The shape today:** pages are pre-built by `build.mjs` from the Supabase
(Postgres) database and served from Cloudflare's edge cache. A few Cloudflare
Pages Functions (`functions/`) handle the dynamic parts. Browsers read the
database directly through Supabase's API, protected by row-level security.
Slow jobs run as scheduled GitHub Actions.

## 1. Architecture and design

**One codebase, clear modules (a modular monolith).** Keep one repo and one
deploy. Split by area: pages and their scripts (`*.html`, `assets/`), the
build (`build.mjs`, `lib/`), server code (`functions/`), the database
(`supabase/migrations/`), and jobs (`scripts/`, `.github/workflows/`).
- *Move a piece out to its own service only when* it needs to scale or deploy
  on its own (for example, image processing or search that slows the build).

**Loose coupling.** Modules talk through a small, named surface: one exported
function per job, one shared helper per concern (`functions/_security.js` for
headers, `functions/api/_supabase.js` for database calls). A change inside a
module shouldn't need edits elsewhere.
- *Config lives in one place.* The database address and public key are
  currently copied into several files; new code imports them from one module,
  and old copies move there when touched.

**Stateless servers.** Functions keep nothing between requests that matters:
sign-in lives in the visitor's token (Supabase Auth), data in Postgres. A
short in-memory cache is fine if losing it changes nothing (the cover page's
15-second switch cache). Never store anything only in a Function's memory.

**Clean code (SOLID, in practice).** One job per function and per file. Add
behavior by adding a case or a module, not by threading flags through old
code. Depend on small interfaces you can fake in a test (pass `fetch` in, as
`functions/_middleware.js` does), which is what makes the tests possible.

## 2. Data

**Cache before you scale the database.** Most reads are pages, and pages are
pre-built and cached at Cloudflare's edge, so most visits never reach the
database. Prefer pre-rendering or an edge cache over a new cache server.
- *Add a cache store (Cloudflare KV, or Redis) when* the same database read
  runs on many requests per second from Functions, or Supabase's dashboard
  shows reads near the plan's limits.

**Scale the database in order:** fix queries and add indexes first (the
Supabase performance advisor lists them), then a bigger instance, then read
replicas for read-heavy traffic. Shard or partition only for a table that
outgrows one machine (tens of millions of rows); nothing here is close.

**Slow work runs in the background.** Emails (Kit sync), review checks, city
requests, backups and the places catalogue already run as scheduled jobs, off
the request path. A request should only do what the person is waiting for.
- *Move to a real queue (Cloudflare Queues, or Supabase's pg_net/pgmq) when* a
  job must run within seconds of an event, or the hourly jobs can't keep up.
  Kafka or RabbitMQ only for very high event volume.

## 3. Resilience

**Design for failure.** Assume Supabase, Cloudflare or a third party will be
slow or down. Every outside call gets a time limit (`AbortController`). Pick
what happens on failure on purpose and write it down: fail open (show the
site) for nice-to-haves like the cover-page switch, fail closed (refuse) for
anything that changes data or touches security.

**Degrade gracefully.** If a feature's data can't load, the rest of the page
still works: the pre-built page stays readable when its script fails, and
missing tables come back empty rather than breaking the build.

**Retries:** only for reads and for writes that are safe to repeat; at most
2–3 tries with growing waits (exponential backoff). Don't retry inside a
visitor's request when it would make them wait; fail fast and show a clear
message. A circuit breaker (stop calling a failing service for a while) is
worth adding when one dependency can make many requests pile up.

**Recoverable by design:** nightly database backup, schema snapshot in the
repo, every change through a pull request, and a site-wide cover while a
database change goes live.

## 4. Shipping and watching

**Automated tests on every change.** See `CLAUDE.md` and `tests/README.md`:
new code comes with tests, enforced by the "Tests included" check; the
"test" check runs unit, end-to-end, security, size and speed suites.

**Containers and orchestration: not needed.** Cloudflare (pages and
Functions) and Supabase already scale automatically. Docker or Kubernetes
would add servers to run and patch for no gain at this size. Revisit only if a
piece moves to its own long-running service (see section 1).

**Observability.** What to know before visitors notice:
- *Is it up?* `/api/health` checks the site and the database. An uptime
  monitor must watch it and alert (not yet set up).
- *Is it erroring?* Browser and Function errors go to your phone through
  `/api/error`. Log errors as one JSON line with what, where, and the request
  path, never personal data.
- *Is it slow?* Speed budgets run on every PR (Lighthouse). Watch Function
  response times in Cloudflare's dashboard; the numbers that matter are
  P50 (the typical request) and P99 (the slowest 1 in 100). Add your own
  timing logs when a Function's P99 passes about 1 second.
- *Is it working for people?* GA4 and Clarity for visits and behavior; the
  database for takes, votes and sign-ups.

## Known gaps (fix when touching the code, or as their own small PRs)

1. **No uptime monitor** watches `/api/health` yet.
2. **Outside calls without a time limit:** `build.mjs` (`fetchTable`),
   `functions/api/take.js`, `locate.js`, `event.js`, `hit.js` and `_notify.js`.
   (`_middleware.js` and `health.js` already have one.)
3. **Copied config:** the Supabase address and public key appear in about
   eight server files plus `build.mjs` and `assets/tv.js`; they should come
   from one module.
