-- Vibes: who a recommendation is for and what kind of time it is.
--
-- People tag a "Do this" take (posts.type hidden_gem), an "It depends" answer
-- (take) or a restaurant with one or two vibes from a fixed list ("Date night",
-- "With the kids", "Loud and late"…). A vibe shows on the item once two
-- different people have given it (the threshold lives in the page code, the
-- views below only count). Warnings ("Don't do this") and timing ("When to go")
-- never take a vibe. TripVibz itself never tags anything: every row is a person
-- tagging under their own user id, like a True / Nope vote.
--
-- Abuse surface and the limits on it:
--   • one row per person per vibe per item (unique indexes);
--   • at most 2 vibes per person per item, 40 tags a day per person (trigger);
--   • the vibe must apply to the item's kind (vibes.on_takes / on_restaurants);
--   • city_id is taken from the item, never from the request;
--   • rows can't be edited, only removed by their owner or an admin.

-- 1. The fixed list. Labels and order are mirrored in assets/v2.js (VIBES);
--    tests/static.mjs checks the two match.
create table if not exists public.vibes (
  slug           text primary key check (slug ~ '^[a-z][a-z-]{1,30}$'),
  label          text not null check (char_length(label) between 2 and 30),
  kind           text not null check (kind in ('who', 'mood')),
  sort           smallint not null,
  on_takes       boolean not null default true,
  on_restaurants boolean not null default true
);
alter table public.vibes enable row level security;
drop policy if exists "read vibes" on public.vibes;
create policy "read vibes" on public.vibes for select using (true);
revoke all on public.vibes from anon, authenticated;
grant select on public.vibes to anon, authenticated;
grant all on public.vibes to service_role;

insert into public.vibes (slug, label, kind, sort, on_takes, on_restaurants) values
  ('first-timer',    'First-timer',    'who',  1,  true,  true),
  ('date-night',     'Date night',     'who',  2,  true,  true),
  ('with-the-kids',  'With the kids',  'who',  3,  true,  true),
  ('the-parents',    'The parents',    'who',  4,  true,  true),
  ('the-group-chat', 'The group chat', 'who',  5,  true,  true),
  ('solo',           'Solo',           'who',  6,  true,  true),
  ('chill',          'Chill',          'mood', 7,  true,  true),
  ('loud-and-late',  'Loud and late',  'mood', 8,  true,  true),
  ('dressy',         'Dressy',         'mood', 9,  false, true),
  ('cheap-and-good', 'Cheap and good', 'mood', 10, true,  true),
  ('old-school',     'Old-school',     'mood', 11, true,  true),
  ('worth-the-wait', 'Worth the wait', 'mood', 12, false, true)
on conflict (slug) do update set label = excluded.label, kind = excluded.kind, sort = excluded.sort,
  on_takes = excluded.on_takes, on_restaurants = excluded.on_restaurants;

-- 2. Tags: one row per person, vibe and item (a take or a restaurant).
create table if not exists public.vibe_tags (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  vibe          text not null references public.vibes(slug) on delete cascade,
  post_id       uuid references public.posts(id) on delete cascade,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  city_id       uuid references public.cities(id) on delete cascade,
  created_at    timestamptz not null default now(),
  check ((post_id is null) <> (restaurant_id is null))
);
create unique index if not exists vibe_tags_one_post on public.vibe_tags (user_id, vibe, post_id) where post_id is not null;
create unique index if not exists vibe_tags_one_restaurant on public.vibe_tags (user_id, vibe, restaurant_id) where restaurant_id is not null;
create index if not exists vibe_tags_city on public.vibe_tags (city_id, vibe);
create index if not exists vibe_tags_user_day on public.vibe_tags (user_id, created_at);
alter table public.vibe_tags enable row level security;

drop policy if exists "read vibe tags" on public.vibe_tags;
create policy "read vibe tags" on public.vibe_tags for select using (true);
drop policy if exists "add own vibe tag" on public.vibe_tags;
create policy "add own vibe tag" on public.vibe_tags for insert with check (auth.uid() = user_id);
drop policy if exists "remove own vibe tag" on public.vibe_tags;
create policy "remove own vibe tag" on public.vibe_tags for delete using (auth.uid() = user_id or public.is_admin());

revoke all on public.vibe_tags from anon, authenticated;
grant select on public.vibe_tags to anon, authenticated;
grant insert (user_id, vibe, post_id, restaurant_id), delete on public.vibe_tags to authenticated;   -- includes anonymous sessions, which tag like they vote; RLS keeps user_id = auth.uid()
grant all on public.vibe_tags to service_role;

create or replace function public.vibe_tags_guard()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare v public.vibes%rowtype; t text; st text; c uuid; n int;
begin
  select * into v from public.vibes where slug = new.vibe;
  if not found then raise exception 'VIBE_UNKNOWN' using errcode = 'P0001'; end if;

  if new.post_id is not null then
    select p.type, p.status, p.city_id into t, st, c from public.posts p where p.id = new.post_id;
    if not found then raise exception 'VIBE_NO_TARGET' using errcode = 'P0001'; end if;
    -- Recommendations only: never a warning or a timing take.
    if t not in ('hidden_gem', 'take') or not v.on_takes then
      raise exception 'VIBE_NOT_FOR_THIS' using errcode = 'P0001';
    end if;
    if coalesce(st, 'approved') in ('rejected', 'hidden') then
      raise exception 'VIBE_NO_TARGET' using errcode = 'P0001';
    end if;
  else
    select r.city_id into c from public.restaurants r where r.id = new.restaurant_id and not r.hidden;
    if not found then raise exception 'VIBE_NO_TARGET' using errcode = 'P0001'; end if;
    if not v.on_restaurants then raise exception 'VIBE_NOT_FOR_THIS' using errcode = 'P0001'; end if;
  end if;
  new.city_id := c;                 -- from the item, never from the request
  new.created_at := now();

  if not public.is_admin() then
    select count(*) into n from public.vibe_tags
     where user_id = new.user_id
       and ((new.post_id is not null and post_id = new.post_id) or (new.restaurant_id is not null and restaurant_id = new.restaurant_id));
    if n >= 2 then raise exception 'VIBE_TWO_MAX' using errcode = 'P0001'; end if;
    select count(*) into n from public.vibe_tags where user_id = new.user_id and created_at > now() - interval '24 hours';
    if n >= 40 then raise exception 'RATE_LIMITED' using errcode = 'P0001'; end if;
  end if;
  return new;
end $fn$;
revoke execute on function public.vibe_tags_guard() from public, anon, authenticated;
drop trigger if exists trg_vibe_tags_guard on public.vibe_tags;
create trigger trg_vibe_tags_guard before insert on public.vibe_tags
  for each row execute function public.vibe_tags_guard();

-- 3. Counts per item. Merged restaurants count toward the row they were merged
--    into; hidden restaurants and removed takes drop out.
create or replace view public.post_vibes with (security_invoker = true) as
select t.post_id, p.city_id, t.vibe, count(distinct t.user_id)::int as people
  from public.vibe_tags t
  join public.posts p on p.id = t.post_id
 where t.post_id is not null and coalesce(p.status, 'approved') = 'approved'
 group by t.post_id, p.city_id, t.vibe;

create or replace view public.restaurant_vibes with (security_invoker = true) as
select coalesce(r.merged_into, r.id) as restaurant_id, r.city_id, t.vibe, count(distinct t.user_id)::int as people
  from public.vibe_tags t
  join public.restaurants r on r.id = t.restaurant_id
 where t.restaurant_id is not null and not r.hidden
 group by coalesce(r.merged_into, r.id), r.city_id, t.vibe;

grant select on public.post_vibes to anon, authenticated, service_role;
grant select on public.restaurant_vibes to anon, authenticated, service_role;

-- 4. Signing in moves an anonymous session's vibes to the account, like its
--    votes (redeem_claim, migration 20261029174500). Where the account already
--    tagged the same item, the account's vibes win, so nobody ends up with more
--    than two on one item. Everything else is unchanged from the live function.
create or replace function public.redeem_claim(tok text)
returns integer language plpgsql security definer set search_path = public as $fn$
declare a uuid; me uuid := auth.uid(); moved int := 0;
begin
  if me is null or not public.jwt_is_verified() then
    raise exception 'SIGN_IN_FIRST' using errcode = 'P0001';
  end if;
  delete from public.claims where token = tok and expires_at > now() returning anon_user_id into a;
  if a is null or a = me then return 0; end if;
  perform set_config('tv.claiming', 'on', true);
  update public.posts set author_id = me, author_verified = true where author_id = a;
  get diagnostics moved = row_count;
  update public.comments set author_id = me, author_verified = true where author_id = a;
  delete from public.votes v where v.user_id = a and exists (select 1 from public.votes w where w.user_id = me and w.post_id = v.post_id);
  update public.votes set user_id = me where user_id = a;
  delete from public.question_votes v where v.user_id = a and exists (select 1 from public.question_votes w where w.user_id = me and w.question_id = v.question_id);
  update public.question_votes set user_id = me, verified = true where user_id = a;
  delete from public.vibe_tags v where v.user_id = a and exists (
    select 1 from public.vibe_tags w where w.user_id = me
       and (w.post_id = v.post_id or w.restaurant_id = v.restaurant_id));
  update public.vibe_tags set user_id = me where user_id = a;
  insert into public.city_tenure(user_id, city_id, tenure, created_at)
    select me, city_id, tenure, created_at from public.city_tenure where user_id = a
    on conflict (user_id, city_id) do nothing;
  delete from public.city_tenure where user_id = a;
  return moved;
end $fn$;
