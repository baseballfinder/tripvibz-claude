-- Supabase security advisor fixes (email of Oct 20, 2026). Run as ONE script in the SQL editor.
--
-- 1. CRITICAL "RLS disabled": public.spatial_ref_sys belongs to PostGIS. Its owner is
--    Supabase's admin role, so we can't turn RLS on or revoke the API's write access to it.
--    Fix = move PostGIS out of the public schema (also clears "extension in public").
--    Safe here: the only PostGIS column is places.geom, which just repeats places.lat/lng
--    and nothing reads it; it is rebuilt from lat/lng below.
-- 2. "Security definer view" on cities_with_counts (a CREATE OR REPLACE on Oct 19 dropped
--    its security_invoker setting) and city_request_counts (counted everyone's requests by
--    running as the owner). Both become ordinary views; request counts now live in a column
--    kept up to date by a trigger, so the cities page shows the same numbers.
-- 3. A trigger-only function was callable from the API; it no longer is.
begin;

-- 1. PostGIS → extensions schema
drop extension if exists postgis cascade;              -- drops places.geom + its index (data kept in lat/lng)
create extension if not exists postgis with schema extensions;
alter table public.places add column if not exists geom extensions.geography(Point, 4326);
update public.places
   set geom = extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
 where lat is not null and lng is not null;
create index if not exists places_geom_idx on public.places using gist (geom);

-- 2a. cities_with_counts runs as the visitor again
alter view public.cities_with_counts set (security_invoker = true);

-- 2b. city request counts without a definer view
alter table public.city_candidates add column if not exists requests integer not null default 0;
update public.city_candidates c
   set requests = (select count(*) from public.city_requests r where r.city_slug = c.slug);

create or replace function public.city_requests_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update city_candidates set requests = requests + 1 where slug = new.city_slug;
  elsif tg_op = 'DELETE' then
    update city_candidates set requests = greatest(requests - 1, 0) where slug = old.city_slug;
  end if;
  return null;
end $$;
revoke execute on function public.city_requests_count() from public, anon, authenticated;
drop trigger if exists trg_city_requests_count on public.city_requests;
create trigger trg_city_requests_count after insert or delete on public.city_requests
  for each row execute function public.city_requests_count();

create or replace view public.city_request_counts with (security_invoker = true) as
  select c.slug, c.name, c.state, c.pop_rank, c.requests
    from public.city_candidates c
   where not exists (select 1 from public.cities x where x.slug = c.slug);
grant select on public.city_request_counts to anon, authenticated;

-- 3. trigger-only function: not an API endpoint
revoke execute on function public.city_requests_limit() from public, anon, authenticated;

commit;
