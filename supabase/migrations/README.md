# Migrations

Merging to `main` applies new files in this folder to the live database
automatically (Supabase GitHub integration, "Deploy to production").
No more pasting SQL into the editor.

## Adding a migration

1. Name it `YYYYMMDDHHMMSS_what_it_does.sql` (UTC timestamp, 14 digits, then a
   lowercase name), later than every file already here. Example:
   `20261023140000_add_saved_places.sql`. `tests/static.mjs` fails on any other name.
2. Write it so it's safe to run once on the live database (it will be).
3. Open a PR. The "Supabase" check shows whether it applies cleanly; merging deploys it.

Files dated before 2026-10-22 here are placeholders that match migrations applied
before this repo tracked them. Older hand-run SQL is in `../applied-by-hand/`.

## New tables need explicit grants (from October 30, 2026)

Supabase stops granting the Data API (supabase-js, PostgREST) access to new
tables in `public` automatically. Every migration that creates a table must
grant access in the same file, or the site gets "permission denied":

```sql
create table public.my_table (...);
alter table public.my_table enable row level security;   -- always; the policies decide who sees what

grant select on public.my_table to anon;                                   -- only if visitors read it
grant select, insert, update, delete on public.my_table to authenticated;  -- only what the policies allow anyway
grant select, insert, update, delete on public.my_table to service_role;
```

Grant only what the site uses (a bot-only table gets `service_role` alone).
New views need `grant select ... to anon, authenticated` the same way.
`tests/static.mjs` fails if a new migration creates a table or view without a grant for it.

## The repo's copy of the schema

`supabase/schema.sql` is a schema-only dump of the live `public` schema (tables, policies,
triggers, functions, grants), refreshed by `.github/workflows/schema-snapshot.yml` (weekly or
on demand) through a pull request whenever it changes. It exists because the early migrations
here are placeholders. To rebuild a database from git: `psql "$NEW_DB_URL" -f supabase/schema.sql`,
then apply migrations newer than the date in the file's header.

## Bot role

The GitHub bots run as `tripvibz_bot` (migration `20261030010000_bot_role.sql`): read/write only
on the tables the three scripts use, row security still on. After the migration: set its password
in the SQL editor and add the `BOT_DB_URL` repo secret; the workflows fall back to `SUPABASE_DB_URL`
until then. Backups and nightly maintenance keep the full connection.
