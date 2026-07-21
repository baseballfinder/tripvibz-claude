# TripVibz

Static site backed by Supabase. Pages are pre-rendered at build time so
crawlers get real content, then the client script hydrates the same markup
for voting and contributing.

## Running it locally

    npm install
    npm run dev        # builds, then serves dist/ on :8080

**Serve `dist/`, not the project root.** Clean URLs like
`/key-west/what-not-to-do/` only exist in the build output. Opening the
source `index.html` directly, or serving the repo root, will 404 on every
city link — the source files are shells with no content until the build
fetches from Supabase and writes the real pages.

## Deploying (Cloudflare Pages)

- Build command: `npm ci && npm run build`
- Output directory: `dist`
- Set `SITE_URL` to the live origin, otherwise canonicals and the sitemap
  point at the default (https://tripvibz.com).

`functions/` stays at the project root — Pages compiles it from there, and
the build deliberately excludes it from `dist` so the handler source is
never served as a static asset.

## Keeping pages fresh

Pre-rendered pages only change when the site rebuilds. Create a Deploy Hook
in the Pages project, then add a Supabase Database Webhook on `posts` INSERT
pointing at it, so a new contribution triggers a rebuild.

## Content fixture

`content.fixture.json` is a gitignored local snapshot used only when
Supabase is unreachable during a local build. It prints a loud warning and
must never be deployed — production always builds from live data.
