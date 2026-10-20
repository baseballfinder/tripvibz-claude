# Migrations

Run in the Supabase SQL editor, oldest file first (names sort by date).

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
`tests/static.mjs` fails if a migration dated after 2026-10-20 creates a table or view without a grant for it.
