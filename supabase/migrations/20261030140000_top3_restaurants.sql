-- Locals' top 3 restaurants.
--
-- A signed-in person picks up to three restaurants for a city, ranked, each
-- with an optional one-line why. The city page rolls everyone's picks up
-- ("Locals' top 3"), verified locals first (local_checks.verified, migration
-- 20261030120000). Restaurant names are typed by the person (there is no
-- restaurant catalogue yet): the same place typed two ways lands on one row
-- through name_key, and admins can rename, merge or hide a row.
--
-- Abuse surface and the limits on it:
--   • one list per person per city (primary key user_id, city_id, rank; a
--     restaurant can appear once per list);
--   • anonymous sessions can't pick or add restaurants (jwt_is_verified());
--   • a person can add at most 10 new restaurant rows a day (trigger);
--   • names and whys go through the same content screen as takes
--     (moderation_violation), and have hard length limits;
--   • a hidden restaurant takes all its picks off the page; merged rows point
--     at the row they were merged into (the page follows merged_into).

-- 1. Restaurants, one row per place per city.
create table if not exists public.restaurants (
  id           uuid primary key default gen_random_uuid(),
  city_id      uuid not null references public.cities(id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 2 and 80),
  -- lower-case, letters and digits only, leading "the " dropped: "The Salty Donut" = "salty donut"
  name_key     text generated always as (
                 btrim(regexp_replace(regexp_replace(lower(name), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g'))
               ) stored,
  neighborhood text check (neighborhood is null or char_length(neighborhood) <= 60),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  hidden       boolean not null default false,            -- admin: off the page, picks kept
  merged_into  uuid references public.restaurants(id) on delete set null,
  unique (city_id, name_key)
);
alter table public.restaurants enable row level security;

drop policy if exists "read restaurants" on public.restaurants;
create policy "read restaurants" on public.restaurants for select using (true);
drop policy if exists "signed-in add restaurant" on public.restaurants;
create policy "signed-in add restaurant" on public.restaurants for insert
  with check (public.jwt_is_verified() and created_by = auth.uid());
drop policy if exists "admin manage restaurants" on public.restaurants;
create policy "admin manage restaurants" on public.restaurants for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin delete restaurants" on public.restaurants;
create policy "admin delete restaurants" on public.restaurants for delete using (public.is_admin());

revoke all on public.restaurants from anon, authenticated;
grant select on public.restaurants to anon, authenticated;
grant insert (city_id, name, neighborhood, created_by) on public.restaurants to authenticated;
grant update (name, neighborhood, hidden, merged_into), delete on public.restaurants to authenticated;   -- RLS: admins only
grant all on public.restaurants to service_role;

-- Content screen (same terms as takes) + a daily cap on new rows per person.
drop trigger if exists trg_moderation_restaurants on public.restaurants;
create trigger trg_moderation_restaurants before insert or update of name on public.restaurants
  for each row execute function public.moderation_guard();

create or replace function public.restaurants_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  if new.created_by is not null and not public.is_admin() then
    select count(*) into n from public.restaurants
     where created_by = new.created_by and created_at > now() - interval '24 hours';
    if n >= 10 then raise exception 'RATE_LIMITED' using errcode = 'P0001'; end if;
  end if;
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
  return new;
end $fn$;
drop trigger if exists trg_restaurants_rate_limit on public.restaurants;
create trigger trg_restaurants_rate_limit before insert on public.restaurants
  for each row execute function public.restaurants_rate_limit();

-- 2. Picks: one ranked list per person per city.
create table if not exists public.top3_picks (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  city_id       uuid not null references public.cities(id) on delete cascade,
  rank          smallint not null check (rank between 1 and 3),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  why           text check (why is null or char_length(why) <= 100),
  updated_at    timestamptz not null default now(),
  primary key (user_id, city_id, rank),
  unique (user_id, city_id, restaurant_id)
);
alter table public.top3_picks enable row level security;

drop policy if exists "read picks" on public.top3_picks;
create policy "read picks" on public.top3_picks for select using (true);
drop policy if exists "own picks insert" on public.top3_picks;
create policy "own picks insert" on public.top3_picks for insert
  with check (public.jwt_is_verified() and user_id = auth.uid());
drop policy if exists "own picks update" on public.top3_picks;
create policy "own picks update" on public.top3_picks for update
  using (user_id = auth.uid()) with check (public.jwt_is_verified() and user_id = auth.uid());
drop policy if exists "own picks delete" on public.top3_picks;
create policy "own picks delete" on public.top3_picks for delete using (user_id = auth.uid() or public.is_admin());

revoke all on public.top3_picks from anon, authenticated;
grant select on public.top3_picks to anon, authenticated;
grant insert (user_id, city_id, rank, restaurant_id, why), update (user_id, city_id, rank, restaurant_id, why, updated_at), delete on public.top3_picks to authenticated;   -- RLS keeps user_id = auth.uid(); upserts touch every payload column
grant all on public.top3_picks to service_role;

create or replace function public.top3_picks_guard()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare v text;
begin
  -- The restaurant must be in the same city as the list.
  if not exists (select 1 from public.restaurants r where r.id = new.restaurant_id and r.city_id = new.city_id) then
    raise exception 'WRONG_CITY' using errcode = 'P0001';
  end if;
  if new.why is not null then
    new.why := nullif(btrim(regexp_replace(new.why, '\s+', ' ', 'g')), '');
    v := public.moderation_violation(new.why);
    if v is not null then
      raise exception 'MODERATION_BLOCKED_%', upper(v) using errcode = 'P0001', hint = 'Submission rejected by content policy.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $fn$;
drop trigger if exists trg_top3_picks_guard on public.top3_picks;
create trigger trg_top3_picks_guard before insert or update on public.top3_picks
  for each row execute function public.top3_picks_guard();

-- 3. The roll-up the city page shows, verified locals first. Hidden restaurants
--    are left out; merged rows count toward the row they were merged into.
create or replace view public.city_top_restaurants with (security_invoker = true) as
with p as (
  select pk.city_id,
         coalesce(r.merged_into, r.id) as restaurant_id,
         pk.user_id, pk.rank, pk.why,
         coalesce(lc.verified and not lc.revoked, false) as verified
    from public.top3_picks pk
    join public.restaurants r on r.id = pk.restaurant_id
    left join public.local_checks lc on lc.user_id = pk.user_id and lc.city_id = pk.city_id
   where not r.hidden
)
select p.city_id, p.restaurant_id, r.name, r.neighborhood,
       count(*)::int                                         as picks,
       count(*) filter (where p.verified)::int               as verified_picks,
       sum(4 - p.rank)::int                                  as points,            -- #1 = 3, #2 = 2, #3 = 1
       sum(case when p.verified then 4 - p.rank else 0 end)::int as verified_points,
       count(*) filter (where p.rank = 1)::int               as firsts
  from p join public.restaurants r on r.id = p.restaurant_id
 where not r.hidden
 group by p.city_id, p.restaurant_id, r.name, r.neighborhood;
grant select on public.city_top_restaurants to anon, authenticated, service_role;
