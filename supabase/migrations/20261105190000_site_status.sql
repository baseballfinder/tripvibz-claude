-- Site status: the switch for the site-wide cover page during database updates.
--
-- functions/_middleware.js reads this one row (public, read-only) and shows the
-- "Back in a few minutes" page while maintenance is on and `until` hasn't
-- passed. The "Cover the site during database updates" workflow
-- (.github/workflows/maintenance-cover.yml) turns it on when a merge to main
-- carries a migration and off once the new version is live and the migration
-- has applied. `until` is a safety stop: a stuck workflow can't leave the site
-- covered past it.
--
-- Dated before 20261105200000_vibes.sql on purpose, so migrations still apply
-- in order whichever of the two pull requests merges first.
--
-- Nobody can write it through the API: no insert/update/delete grants or
-- policies for anon or authenticated. The workflow writes it over the database
-- connection (SUPABASE_DB_URL), as the nightly maintenance job does.

create table if not exists public.site_status (
  id          smallint primary key default 1 check (id = 1),
  maintenance boolean not null default false,
  reason      text check (reason is null or char_length(reason) <= 200),
  until       timestamptz,
  updated_at  timestamptz not null default now()
);
insert into public.site_status (id) values (1) on conflict (id) do nothing;

alter table public.site_status enable row level security;
drop policy if exists "read site status" on public.site_status;
create policy "read site status" on public.site_status for select using (true);

revoke all on public.site_status from anon, authenticated;
grant select (id, maintenance, until) on public.site_status to anon, authenticated;
grant all on public.site_status to service_role;
