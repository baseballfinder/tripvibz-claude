-- A limited database role for the GitHub bots (kit-sync, city-requests,
-- take-reviews). Until now all of them used SUPABASE_DB_URL — the full
-- postgres connection — so a leaked repo secret meant the whole database.
-- tripvibz_bot can read and write only what those three scripts touch.
--
-- After this migration is applied, one step by hand (the password never goes
-- in git):
--   1. Supabase → SQL editor:   alter role tripvibz_bot with password '<long random>';
--   2. GitHub → repo secrets:   BOT_DB_URL = the SUPABASE_DB_URL value with the user changed to
--      tripvibz_bot and the password to the one from step 1
--      (same host as SUPABASE_DB_URL; for the session pooler the user is tripvibz_bot.<project ref>)
-- The bot workflows use BOT_DB_URL when it exists and fall back to SUPABASE_DB_URL
-- until then. Backups and nightly maintenance keep the full connection (pg_dump
-- and auth.users need it).
--
-- Row security applies to this role like any other, so each table it uses
-- gets an explicit policy "to tripvibz_bot"; there is no bypass.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tripvibz_bot') then
    -- LOGIN with no password: cannot connect until the password is set by hand.
    create role tripvibz_bot login;
  end if;
end $$;

grant usage on schema public to tripvibz_bot;

-- kit-sync: new newsletter signups -> Kit, then mark them synced
grant select on public.email_signups to tripvibz_bot;
grant update (synced_at, sync_error, attempts) on public.email_signups to tripvibz_bot;
drop policy if exists "bot syncs signups" on public.email_signups;
create policy "bot syncs signups" on public.email_signups for all to tripvibz_bot using (true) with check (true);

-- city-requests: count asks, notify, open a city (+ its five questions)
grant select on public.city_requests to tripvibz_bot;
grant select on public.city_candidates to tripvibz_bot;
grant update (notified_at, opened_at) on public.city_candidates to tripvibz_bot;
grant select, insert on public.cities to tripvibz_bot;
grant select, insert on public.questions to tripvibz_bot;
drop policy if exists "bot reads requests" on public.city_requests;
create policy "bot reads requests" on public.city_requests for select to tripvibz_bot using (true);
drop policy if exists "bot manages candidates" on public.city_candidates;
create policy "bot manages candidates" on public.city_candidates for all to tripvibz_bot using (true) with check (true);
drop policy if exists "bot opens cities" on public.cities;
create policy "bot opens cities" on public.cities for all to tripvibz_bot using (true) with check (true);
drop policy if exists "bot seeds questions" on public.questions;
create policy "bot seeds questions" on public.questions for all to tripvibz_bot using (true) with check (true);

-- take-reviews: read pending takes with a new topic, record the review, set status
grant select on public.posts to tripvibz_bot;
grant update (status, moderated_at) on public.posts to tripvibz_bot;
grant select, insert on public.take_reviews to tripvibz_bot;
drop policy if exists "bot reviews takes" on public.posts;
create policy "bot reviews takes" on public.posts for all to tripvibz_bot using (true) with check (true);
drop policy if exists "bot records reviews" on public.take_reviews;
create policy "bot records reviews" on public.take_reviews for all to tripvibz_bot using (true) with check (true);

-- The status lock on posts trusts the moderation bot like it trusts the
-- service role (it never edits content, only status/moderated_at).
create or replace function public.posts_lock_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status and not public.is_admin()
     and current_user not in ('postgres', 'supabase_admin', 'service_role', 'tripvibz_bot') then
    new.status := old.status;
  end if;
  return new;
end $$;

create or replace function public.tv_is_privileged()
returns boolean
language sql
stable
set search_path = public
as $$
  select public.is_admin()
      or current_user in ('postgres', 'supabase_admin', 'service_role', 'tripvibz_bot')
      or current_setting('tv.claiming', true) = 'on';
$$;

-- Read-only catalog checks (tests/db-security.sql) can run as the bot too.
grant usage on schema supabase_migrations to tripvibz_bot;
grant select on supabase_migrations.schema_migrations to tripvibz_bot;
