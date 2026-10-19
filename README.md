# TripVibz

Static site backed by Supabase. Pages are pre-rendered at build time so
crawlers get real content, then the client script hydrates the same markup
for voting and contributing.

## Running it locally

    npm install        # once, installs esbuild
    npm run dev        # builds, then serves dist/ on :8080

`npm run dev` and `npm run build` both run `npm install` first, so a fresh
clone works without remembering that step.

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

## Sign-in providers

Google is live. Facebook and TikTok are built but switched off in `assets/tv.js`
(`var SIGNIN = { facebook: false, tiktok: false }`) until their setup is done;
add `?preview=signin` to any page to see the buttons. Both need the public
[privacy](https://www.tripvibz.com/privacy/) and [terms](https://www.tripvibz.com/terms/) pages.

**Instagram** has no sign-in for websites (Meta's Instagram login is for
business accounts managing their own posts). People with Instagram use the
Facebook account it's linked to; the sign-in box says so.

**Facebook** (built into Supabase):
1. developers.facebook.com → Create app → "Authenticate and request data from users with Facebook Login" → business portfolio for TripVibz.
2. Use cases → Facebook Login → Settings: Valid OAuth Redirect URI = `https://nkxorlktzbgwqnfwmuus.supabase.co/auth/v1/callback`. Permissions: `email`, `public_profile`.
3. App settings → Basic: privacy policy URL `https://www.tripvibz.com/privacy/`, terms `https://www.tripvibz.com/terms/`, data deletion instructions URL `https://www.tripvibz.com/privacy/`, app icon, category Travel. Switch the app to Live (business verification may be asked for).
4. Supabase → Authentication → Providers → Facebook: paste App ID and App Secret, enable.
5. Set `facebook: true` in `assets/tv.js` (pull request).

**TikTok** (our own bridge, `functions/api/auth/tiktok/`):
1. developers.tiktok.com → Manage apps → Connect an app → add product **Login Kit** (Web). Redirect URI: `https://www.tripvibz.com/api/auth/tiktok/callback`. Scope: `user.info.basic`. Add privacy + terms URLs, submit for review.
2. Cloudflare → Pages → tripvibz → Settings → Variables and Secrets (Production): `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (encrypted), and `SUPABASE_SERVICE_ROLE_KEY` (encrypted; Supabase → Project Settings → API keys → secret key).
3. Set `tiktok: true` in `assets/tv.js` (pull request).

TikTok accounts get a placeholder email (`tt-…@tiktok.users.tripvibz.com`, never mailed) because TikTok shares no email address.
