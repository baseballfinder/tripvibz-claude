-- Top-3 picker: suggestions ordered by how well known a place is (follows
-- 20261030160000_places_catalog).
--
-- A match list sorted only by text similarity puts "Joe's Pizza" (a kiosk) next
-- to "Joe's Stone Crab". Suggestions now sort by review count when the
-- popularity enrichment has run (columns below, filled by a later step from a
-- ratings source and refreshed within its caching window), then by how many
-- TripVibz locals already picked the place, then by Overture's confidence.
-- Before typing, the field offers the city's best-known places so the common
-- picks are one tap away.

alter table public.places_catalog
  add column if not exists review_count integer,
  add column if not exists rating real,
  add column if not exists popularity_source text,
  add column if not exists popularity_at timestamptz;
create index if not exists places_catalog_city_popular
  on public.places_catalog (city_id, review_count desc nulls last, confidence desc nulls last);

-- Return type changes (two new columns), so the function is dropped and recreated.
drop function if exists public.search_places(uuid, text);
create function public.search_places(p_city uuid, p_q text)
returns table (id text, name text, category text, address text, locality text, phone text, website text,
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
   where c.city_id = p_city and length(q.key) >= 2
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

-- Before typing: the city's best-known places, same ordering, no text filter.
-- Empty until there is something to rank by (a review count or a pick).
create or replace function public.popular_places(p_city uuid)
returns table (id text, name text, category text, address text, locality text, phone text, website text,
               lat double precision, lng double precision, status text, review_count integer, picks integer)
language sql stable set search_path = public, extensions as $fn$
  with pk as (
    select r.place_id, count(*)::int as picks
      from public.top3_picks t join public.restaurants r on r.id = t.restaurant_id
     where r.city_id = p_city and r.place_id is not null
     group by r.place_id
  )
  select c.id, c.name, c.category, c.address, c.locality, c.phone, c.website, c.lat, c.lng, c.status,
         c.review_count, coalesce(pk.picks, 0) as picks
    from public.places_catalog c left join pk on pk.place_id = c.id
   where c.city_id = p_city and coalesce(c.status, '') <> 'closed'
     and (c.review_count is not null or pk.picks is not null)
   order by c.review_count desc nulls last, coalesce(pk.picks, 0) desc, c.confidence desc nulls last
   limit 8;
$fn$;
grant execute on function public.popular_places(uuid) to anon, authenticated, service_role;
