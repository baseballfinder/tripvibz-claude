-- Guide tab (city pages): takes get a real spot on the map.
--
-- 1. The places catalogue (Overture, scripts/places_catalog.py) also holds
--    "spots": parks, beaches, landmarks, museums, stadiums, plazas and the
--    well-known neighborhoods (Overture divisions linked to Wikidata), tagged
--    kind = 'spot'. The restaurant picker keeps searching food and drink only.
-- 2. public.places (the spots takes point at, posts.place_id) learns where a
--    row came from. A catalogue spot is copied in only when a take uses it,
--    server-side (ensure_spot_from_place), so nobody can type a fake position.
-- 3. search_take_places: the add page's "Where is this?" search. Spots already
--    on TripVibz first, then catalogue spots, then restaurants and bars.
-- 4. A take's spot must be in the take's city (it used to silently move the
--    take to the spot's city).
-- 5. The live takes that name a spot are pinned to it (checked by hand
--    against Overture, Nov 7 2026). "Whole city", "Getting to the Smokies" and
--    the Intracoastal water taxi aren't one spot and stay off the map.

-- 1. Catalogue kinds.
alter table public.places_catalog
  add column if not exists kind text not null default 'eat' check (kind in ('eat', 'spot'));
create index if not exists places_catalog_city_kind on public.places_catalog (city_id, kind);

-- Restaurant search: food and drink only (same ranking as 20261030180000).
create or replace function public.search_places(p_city uuid, p_q text)
returns table(id text, name text, category text, address text, locality text, phone text, website text,
              lat double precision, lng double precision, status text, review_count integer, picks integer)
language sql stable set search_path = public, extensions as $fn$
  with q as (
    select btrim(regexp_replace(regexp_replace(lower(coalesce(p_q, '')), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g')) as key
  ),
  pk as (
    select r.place_id, count(*)::int as picks
      from public.top3_picks t join public.restaurants r on r.id = t.restaurant_id
     where r.city_id = p_city and r.place_id is not null
     group by r.place_id
  )
  select c.id, c.name, c.category, c.address, c.locality, c.phone, c.website, c.lat, c.lng, c.status,
         c.review_count, coalesce(pk.picks, 0) as picks
    from public.places_catalog c
    cross join q
    left join pk on pk.place_id = c.id
   where c.city_id = p_city and c.kind = 'eat' and length(q.key) >= 2
     and (c.name_key like q.key || '%' or c.name_key like '%' || q.key || '%' or similarity(c.name_key, q.key) > 0.3)
   order by (c.status = 'closed') asc,
            (c.name_key like q.key || '%') desc,
            (c.name_key like '%' || q.key || '%') desc,
            c.review_count desc nulls last,
            coalesce(pk.picks, 0) desc,
            similarity(c.name_key, q.key) desc,
            c.confidence desc nulls last
   limit 8;
$fn$;
grant execute on function public.search_places(uuid, text) to anon, authenticated, service_role;

-- 2. Where a spot came from.
alter table public.places
  add column if not exists source     text not null default 'tripvibz' check (source in ('tripvibz', 'overture')),
  add column if not exists catalog_id text unique,
  add column if not exists address    text;

create or replace function public.place_name_key(n text) returns text
language sql immutable set search_path = public as $fn$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(n, '')), '^\s*the\s+', ''), '[^a-z0-9]+', ' ', 'g'))
$fn$;

-- A catalogue place (spot or restaurant) -> the places row a take points at.
-- Any session that can post a take may call it: signed-in people and the
-- lazy anonymous sessions (both use the "authenticated" role); visitors with
-- no session at all can't. It only ever copies a catalogue row, once.
create or replace function public.ensure_spot_from_place(p_place text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare c public.places_catalog%rowtype; pid uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'P0001'; end if;
  select * into c from public.places_catalog where id = p_place;
  if not found then raise exception 'UNKNOWN_PLACE' using errcode = 'P0001'; end if;
  select id into pid from public.places where catalog_id = c.id;
  if pid is not null then return pid; end if;
  -- A spot TripVibz already has under the same name in this city: use that one.
  select id into pid from public.places p
   where p.city_id = c.city_id and p.catalog_id is null and public.place_name_key(p.name) = public.place_name_key(c.name)
   order by p.created_at limit 1;
  if pid is not null then return pid; end if;
  insert into public.places (name, category, neighborhood, lat, lng, geom, city_id, source, catalog_id, address)
  values (left(c.name, 80), case when c.kind = 'eat' then 'food' else coalesce(c.category, 'spot') end, c.locality,
          c.lat, c.lng, extensions.st_setsrid(extensions.st_makepoint(c.lng, c.lat), 4326)::extensions.geography,
          c.city_id, 'overture', c.id, c.address)
  returning id into pid;
  return pid;
end $fn$;
revoke all on function public.ensure_spot_from_place(text) from public;
revoke execute on function public.ensure_spot_from_place(text) from anon;
grant execute on function public.ensure_spot_from_place(text) to authenticated, service_role;

-- 3. "Where is this?" on the add page.
--    ref: 'p:<places.id>' for a spot TripVibz has, 'c:<catalogue id>' otherwise.
create or replace function public.search_take_places(p_city uuid, p_q text)
returns table(ref text, name text, kind text, category text, detail text, lat double precision, lng double precision, takes integer)
language sql stable set search_path = public, extensions as $fn$
  with q as (select public.place_name_key(p_q) as key),
  used as (
    select place_id, count(*)::int as n from public.posts
     where city_id = p_city and place_id is not null and status = 'approved' group by place_id
  ),
  have as (
    select 'p:' || p.id::text as ref, p.name, 'spot'::text as kind, p.category, coalesce(p.neighborhood, p.address) as detail,
           p.lat, p.lng, coalesce(u.n, 0) as takes, p.catalog_id,
           0 as tier, public.place_name_key(p.name) as nk
      from public.places p left join used u on u.place_id = p.id
     where p.city_id = p_city
  ),
  cat as (
    select 'c:' || c.id as ref, c.name, c.kind, c.category, coalesce(c.address, c.locality) as detail,
           c.lat, c.lng, 0 as takes, c.id as catalog_id,
           case when c.kind = 'spot' then 1 else 2 end as tier, c.name_key as nk
      from public.places_catalog c
     where c.city_id = p_city and coalesce(c.status, '') <> 'closed'
  ),
  hits as (
    select h.*, q.key from have h cross join q
     where length(q.key) >= 2 and (h.nk like q.key || '%' or h.nk like '% ' || q.key || '%' or similarity(h.nk, q.key) > 0.35)
    union all
    select c.*, q.key from cat c cross join q
     where length(q.key) >= 2 and (c.nk like q.key || '%' or c.nk like '% ' || q.key || '%' or similarity(c.nk, q.key) > 0.35)
       and not exists (select 1 from have h where h.catalog_id = c.catalog_id or (h.catalog_id is null and h.nk = c.nk))
  )
  select ref, name, kind, category, detail, lat, lng, takes
    from hits
   order by (nk like key || '%') desc, tier, takes desc, similarity(nk, key) desc, length(name)
   limit 8;
$fn$;
grant execute on function public.search_take_places(uuid, text) to anon, authenticated, service_role;

-- 4. A take's spot is in the take's city.
create or replace function public.posts_sync_city() returns trigger
language plpgsql set search_path = public as $fn$
declare pc uuid;
begin
  if new.place_id is not null then
    select city_id into pc from public.places where id = new.place_id;
    if pc is null then raise exception 'UNKNOWN_PLACE' using errcode = 'P0001'; end if;
    if new.city_id is not null and new.city_id <> pc then raise exception 'WRONG_CITY' using errcode = 'P0001'; end if;
    new.city_id := pc;
  end if;
  return new;
end $fn$;

-- 5. Pin the live takes that name a spot.
do $seed$
declare
  r record; pid uuid;
begin
  for r in select * from (values
    ('fort-lauderdale', 'Beaches',            'Fort Lauderdale Beach', 'beach',     26.14064, -80.10198, 'Fort Lauderdale Beach'),
    ('fort-lauderdale', 'Las Olas Boulevard', 'Las Olas Boulevard',    'street',    26.11938, -80.13250, 'Downtown Fort Lauderdale'),
    ('knoxville',       'Market Square',      'Market Square',         'plaza',     35.96561, -83.91984, 'Downtown Knoxville'),
    ('knoxville',       'Neyland Stadium',    'Neyland Stadium',       'stadium',   35.95499, -83.92513, 'University of Tennessee'),
    ('knoxville',       'Old City',           'Old City',              'neighborhood', 35.97049, -83.91847, 'Downtown Knoxville'),
    ('miami',           'Little Havana',      'Little Havana',         'neighborhood', 25.76550, -80.21900, 'Miami'),
    ('miami',           'Wynwood',            'Wynwood Walls',         'attraction', 25.80100, -80.19900, 'Wynwood')
  ) as v(slug, label, name, category, lat, lng, neighborhood)
  loop
    select p.id into pid from public.places p join public.cities c on c.id = p.city_id
     where c.slug = r.slug and public.place_name_key(p.name) = public.place_name_key(r.name) limit 1;
    if pid is null then
      insert into public.places (name, category, neighborhood, lat, lng, geom, city_id, source)
      select r.name, r.category, r.neighborhood, r.lat, r.lng,
             extensions.st_setsrid(extensions.st_makepoint(r.lng, r.lat), 4326)::extensions.geography, c.id, 'tripvibz'
        from public.cities c where c.slug = r.slug
      returning id into pid;
    end if;
    if pid is not null then
      update public.posts p set place_id = pid
        from public.cities c
       where c.id = p.city_id and c.slug = r.slug and p.place_label = r.label and p.place_id is null;
    end if;
    pid := null;
  end loop;
end $seed$;
