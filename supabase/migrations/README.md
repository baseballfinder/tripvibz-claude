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
