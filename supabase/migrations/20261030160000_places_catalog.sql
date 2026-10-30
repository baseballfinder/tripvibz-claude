-- Places catalogue for the top-3 picker (follows 20261030140000_top3_restaurants).
--
-- Typed restaurant names were the weak point: misspellings, and no address to
-- give directions from. Names now come from a catalogue of eat-and-drink places
-- near each city, loaded monthly from Overture Maps' open places data
-- (CDLA-Permissive 2.0 — storing and showing it is allowed, with attribution)
-- by .github/workflows/places-catalog.yml → scripts/places_catalog.py. The
-- picker searches it with fuzzy matching (search_places), and a pick creates
-- the restaurant row server-side from the catalogue entry
-- (ensure_restaurant_from_place) so nobody types a misspelled name or a fake
-- address. Typing a name the catalogue lacks still works (source "local").

-- 1. Restaurants learn where they are.
alter table public.restaurants
  add column if not exists place_id text unique,                       -- Overture place id
  add column if not exists address  text,
  add column if not exists phone    text,
  add column if not exists website  text,
  add column if not exists lat      double precision,
  add column if not exists lng      double precision,
  add column if not exists source   text not null default 'local' check (source in ('local', 'overture'));

-- Hand-typed rows: one per spelling-folded name per city. Catalogue rows are
-- unique by place_id instead, so two locations of one chain are two rows.
alter table public.restaurants drop constraint if exists restaurants_city_id_name_key_key;
create unique index if not exists restaurants_city_name_key_local on public.restaurants (city_id, name_key) where place_id is null;

-- Admins may fix the copied details (RLS keeps these updates to admins).
grant update (place_id, address, phone, website, lat, lng, source) on public.restaurants to authenticated;

-- 2. The catalogue. Written only by the monthly workflow (bot role) and the
--    service role; everyone can read it.
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.places_catalog (
  id          text primary key,                           -- Overture place id
  city_id     uuid not null references public.cities(id) on delete cascade,
  name        text not null,
  name_key    text generated always as (
                btrim(regexp_replace(regexp_replace(lower(name), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g'))
              ) stored,
  category    text,                                       -- Overture primary category, e.g. cuban_restaurant
  address     text,
  locality    text,
  postcode    text,
  lat         double precision not null,
  lng         double precision not null,
  phone       text,
  website     text,
  instagram   text,
  confidence  real,
  status      text,                                       -- Overture operating_status (open / closed / null)
  release     text,                                       -- Overture release the row came from
  updated_at  timestamptz not null default now()
);
create index if not exists places_catalog_city_name_trgm on public.places_catalog using gin (name_key extensions.gin_trgm_ops);
create index if not exists places_catalog_city on public.places_catalog (city_id);
alter table public.places_catalog enable row level security;
drop policy if exists "read catalogue" on public.places_catalog;
create policy "read catalogue" on public.places_catalog for select using (true);
drop policy if exists "bot writes catalogue" on public.places_catalog;
create policy "bot writes catalogue" on public.places_catalog for all to tripvibz_bot using (true) with check (true);
revoke all on public.places_catalog from anon, authenticated;
grant select on public.places_catalog to anon, authenticated;
grant select, insert, update, delete on public.places_catalog to tripvibz_bot;
grant all on public.places_catalog to service_role;

-- 3. Type-ahead: prefix and substring matches first, then fuzzy (pg_trgm), open places first.
create or replace function public.search_places(p_city uuid, p_q text)
returns table (id text, name text, category text, address text, locality text, phone text, website text, lat double precision, lng double precision, status text)
language sql stable set search_path = public, extensions as $fn$
  with q as (
    select btrim(regexp_replace(regexp_replace(lower(coalesce(p_q, '')), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g')) as key
  )
  select c.id, c.name, c.category, c.address, c.locality, c.phone, c.website, c.lat, c.lng, c.status
    from public.places_catalog c, q
   where c.city_id = p_city and length(q.key) >= 2
     and (c.name_key like q.key || '%' or c.name_key like '%' || q.key || '%' or similarity(c.name_key, q.key) > 0.3)
   order by (c.status = 'closed') asc,
            (c.name_key like q.key || '%') desc,
            (c.name_key like '%' || q.key || '%') desc,
            similarity(c.name_key, q.key) desc,
            c.confidence desc nulls last
   limit 8;
$fn$;
grant execute on function public.search_places(uuid, text) to anon, authenticated, service_role;

-- 4. A pick from the catalogue: create (or return) the restaurant row for that
--    place, copying its details server-side so a client can't supply a fake
--    address or phone. Signed-in people only; counts toward the daily cap.
create or replace function public.ensure_restaurant_from_place(p_place text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare c public.places_catalog%rowtype; rid uuid;
begin
  if not public.jwt_is_verified() then raise exception 'NOT_SIGNED_IN' using errcode = 'P0001'; end if;
  select * into c from public.places_catalog where id = p_place;
  if not found then raise exception 'UNKNOWN_PLACE' using errcode = 'P0001'; end if;
  select id into rid from public.restaurants where place_id = c.id;
  if rid is not null then return rid; end if;
  -- Same name already typed by hand in this city: attach the catalogue details to that row.
  select id into rid from public.restaurants r
   where r.city_id = c.city_id and r.place_id is null
     and r.name_key = btrim(regexp_replace(regexp_replace(lower(c.name), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g'));
  if rid is not null then
    update public.restaurants set place_id = c.id, address = c.address, phone = c.phone, website = c.website,
           lat = c.lat, lng = c.lng, source = 'overture', neighborhood = coalesce(neighborhood, c.locality)
     where id = rid;
    return rid;
  end if;
  insert into public.restaurants (city_id, name, neighborhood, place_id, address, phone, website, lat, lng, source, created_by)
  values (c.city_id, c.name, c.locality, c.id, c.address, c.phone, c.website, c.lat, c.lng, 'overture', auth.uid())
  returning id into rid;
  return rid;
end $fn$;
revoke execute on function public.ensure_restaurant_from_place(text) from public, anon;
grant execute on function public.ensure_restaurant_from_place(text) to authenticated, service_role;

-- 5. The roll-up gains the details the page shows (directions, call, website).
--    Columns change position, so the view is recreated rather than replaced.
drop view if exists public.city_top_restaurants;
create view public.city_top_restaurants with (security_invoker = true) as
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
select p.city_id, p.restaurant_id, r.name, r.neighborhood, r.address, r.phone, r.website, r.lat, r.lng, r.source,
       count(*)::int                                         as picks,
       count(*) filter (where p.verified)::int               as verified_picks,
       sum(4 - p.rank)::int                                  as points,            -- #1 = 3, #2 = 2, #3 = 1
       sum(case when p.verified then 4 - p.rank else 0 end)::int as verified_points,
       count(*) filter (where p.rank = 1)::int               as firsts
  from p join public.restaurants r on r.id = p.restaurant_id
 where not r.hidden
 group by p.city_id, p.restaurant_id, r.name, r.neighborhood, r.address, r.phone, r.website, r.lat, r.lng, r.source;
grant select on public.city_top_restaurants to anon, authenticated, service_role;
