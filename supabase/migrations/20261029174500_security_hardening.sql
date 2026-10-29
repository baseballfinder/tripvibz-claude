-- Security hardening (review of 2026-10-29; findings in the claude.ai Project
-- doc claude/security-review-2026-10-29.md).
--
-- What was wrong, in plain words:
--   1. A signed-in visitor could add an entry to a city's "Worst times to visit"
--      calendar and it went live at once (city_events defaulted to 'approved').
--   2. The author of a take could edit their own vote counts (ups/downs), the
--      server-stamped "posted from near <city>" flag and the moderation notes,
--      because the "modify own post" rule let them change any column.
--   3. The author of a reply could un-hide it after an admin hid it, and give
--      it the "<City> local" badge, for the same reason.
--   4. Titles and bodies had no size limit at all (the page caps them at 400
--      characters, but the API did not).
--   5. Everyone could read the rough-location table (local_checks) in full,
--      including the "region"/"far" band and the time of each check.
--   6. The anon/authenticated API roles held TRUNCATE/TRIGGER/REFERENCES on
--      every table (Supabase's old default); nothing needs them.
--
-- Every guard below follows the pattern already used by posts_lock_status:
-- admins, the service role and the database owner are never restricted; for
-- everyone else protected columns silently keep their old value, so an admin
-- page that PATCHes a whole row keeps working and a tampered request simply
-- has no effect.
--
-- Safe to run once on the live database: every constraint was checked against
-- the longest existing values first (max title 157, body 53, event name 39,
-- blurb 165 characters), and every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Size limits. Mirrored in functions/api/take.js.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'posts_title_len') then
    alter table public.posts add constraint posts_title_len
      check (char_length(title) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'posts_body_len') then
    alter table public.posts add constraint posts_body_len
      check (body is null or char_length(body) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comments_body_len') then
    alter table public.comments add constraint comments_body_len
      check (char_length(body) between 1 and 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'city_events_name_len') then
    alter table public.city_events add constraint city_events_name_len
      check (char_length(name) between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'city_events_blurb_len') then
    alter table public.city_events add constraint city_events_blurb_len
      check (blurb is null or char_length(blurb) <= 400);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'city_events_source_len') then
    alter table public.city_events add constraint city_events_source_len
      check (source is null or char_length(source) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_len') then
    alter table public.profiles add constraint profiles_display_name_len
      check (display_name is null or char_length(display_name) <= 60);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Who may bypass the guards: admins, the service role, the database owner,
--    and redeem_claim() while it moves an anonymous person's history to their
--    signed-in account (it sets tv.claiming, see posts_lock_verified).
-- ---------------------------------------------------------------------------
create or replace function public.tv_is_privileged()
returns boolean
language sql
stable
set search_path = public
as $$
  select public.is_admin()
      or current_user in ('postgres', 'supabase_admin', 'service_role')
      or current_setting('tv.claiming', true) = 'on';
$$;
revoke all on function public.tv_is_privileged() from public;
grant execute on function public.tv_is_privileged() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. posts: counters, server stamps and moderation fields are read-only for
--    the author. (status and author_verified were already locked by
--    posts_lock_status / posts_lock_verified; this covers the rest.)
-- ---------------------------------------------------------------------------
create or replace function public.posts_lock_protected()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.tv_is_privileged() then return new; end if;
  new.ups               := old.ups;
  new.downs             := old.downs;
  new.score             := old.score;
  new.comment_count     := old.comment_count;
  new.city_match        := old.city_match;
  new.submitted_city    := old.submitted_city;
  new.submitted_region  := old.submitted_region;
  new.submitted_country := old.submitted_country;
  new.moderated_at      := old.moderated_at;
  new.moderated_by      := old.moderated_by;
  new.moderation_note   := old.moderation_note;
  new.created_at        := old.created_at;
  new.author_id         := old.author_id;
  -- A new topic goes through review on insert (posts_set_status); adding one
  -- to an already-approved take would skip that, so the topic is fixed too.
  new.topic             := old.topic;
  return new;
end $$;
drop trigger if exists trg_posts_lock_protected on public.posts;
create trigger trg_posts_lock_protected
  before update on public.posts
  for each row execute function public.posts_lock_protected();

-- ---------------------------------------------------------------------------
-- 4. comments: the author cannot un-hide a reply, award it the local badge,
--    change its counts, or move it to another take.
-- ---------------------------------------------------------------------------
create or replace function public.comments_lock_protected()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.tv_is_privileged() then return new; end if;
  new.status          := old.status;
  new.author_verified := old.author_verified;
  new.ups             := old.ups;
  new.downs           := old.downs;
  new.created_at      := old.created_at;
  new.author_id       := old.author_id;
  new.post_id         := old.post_id;
  new.path            := old.path;
  return new;
end $$;
drop trigger if exists trg_comments_lock_protected on public.comments;
create trigger trg_comments_lock_protected
  before update on public.comments
  for each row execute function public.comments_lock_protected();

-- ---------------------------------------------------------------------------
-- 5. city_events: a visitor's calendar entry waits for the editors.
--    Visitors' inserts become 'pending' (invisible to the site, which only
--    reads approved rows) with a 5-a-day limit; on update the editorial fields
--    stay as they were. Editors' own entries are unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.city_events_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare n int;
begin
  if public.tv_is_privileged() then return new; end if;
  if tg_op = 'INSERT' then
    if new.author_id is not null then
      select count(*) into n from public.city_events
        where author_id = new.author_id and created_at > now() - interval '24 hours';
      if n >= 5 then raise exception 'RATE_LIMITED' using errcode = 'P0001'; end if;
    end if;
    new.status      := 'pending'::moderation_status;
    new.ups         := 0;
    new.verified_at := null;
    new.check_note  := null;
    return new;
  end if;
  new.status      := old.status;
  new.ups         := old.ups;
  new.verified_at := old.verified_at;
  new.check_note  := old.check_note;
  new.author_id   := old.author_id;
  new.city_id     := old.city_id;
  new.created_at  := old.created_at;
  return new;
end $$;
drop trigger if exists trg_city_events_guard on public.city_events;
create trigger trg_city_events_guard
  before insert or update on public.city_events
  for each row execute function public.city_events_guard();

-- ---------------------------------------------------------------------------
-- 6. votes: a vote can change value (true <-> nope) but never move to another
--    take or person — apply_vote() only re-counts when the value changes, so a
--    moved vote would leave the old take's count wrong.
-- ---------------------------------------------------------------------------
create or replace function public.votes_lock_target()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.tv_is_privileged() then return new; end if;
  new.post_id    := old.post_id;
  new.user_id    := old.user_id;
  new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists trg_votes_lock_target on public.votes;
create trigger trg_votes_lock_target
  before update on public.votes
  for each row execute function public.votes_lock_target();

-- ---------------------------------------------------------------------------
-- 7. profiles: karma is earned, not typed in. (is_admin was already guarded by
--    the "update own profile" policy.)
-- ---------------------------------------------------------------------------
create or replace function public.profiles_lock_protected()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.tv_is_privileged() then return new; end if;
  new.karma      := old.karma;
  new.created_at := old.created_at;
  new.id         := old.id;
  return new;
end $$;
drop trigger if exists trg_profiles_lock_protected on public.profiles;
create trigger trg_profiles_lock_protected
  before update on public.profiles
  for each row execute function public.profiles_lock_protected();

-- ---------------------------------------------------------------------------
-- 8. Rough-location tables. The site needs only "is this author near this
--    city" to draw the ✓ (assets/v2.js) and admin.html needs the revoked flag;
--    the band and the time of each check stay server-side. contributor_locality
--    is a server-side counter nothing in the browser reads.
-- ---------------------------------------------------------------------------
revoke select on public.local_checks from anon, authenticated;
grant select (user_id, city_id, near, revoked) on public.local_checks to anon, authenticated;

drop policy if exists "read locality" on public.contributor_locality;
drop policy if exists "admin read locality" on public.contributor_locality;
create policy "admin read locality" on public.contributor_locality
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 9. Least privilege for the API roles. TRUNCATE ignores row security; TRIGGER
--    and REFERENCES are schema-change rights. The site uses none of them.
-- ---------------------------------------------------------------------------
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
