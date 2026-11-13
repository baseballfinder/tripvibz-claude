-- Remove Knoxville and Asheville from TripVibz and close their region
-- (James, 2026-11-13). TripVibz does not cover East Tennessee, the Great
-- Smoky Mountains or Western North Carolina: no city page and no city
-- request from there. Old URLs redirect to /cities/
-- (data/removed-cities.json -> _redirects).
--
-- 1. What goes: the two city rows and everything hanging off them. At the
--    time of writing: Knoxville had 5 takes (all from the admin account),
--    5 questions with a few votes, 5 calendar entries, 3 places, 3 restaurants
--    with 3 top-3 picks and 2,961 places-catalogue rows; Asheville had no
--    takes, 5 questions, 5 calendar entries and 1,965 places-catalogue rows.
--    The public rows are saved in data/removed/*-2026-11-13.json.
-- 2. The area rule: a trigger on cities and on city_candidates refuses any
--    row inside the area, so a city there cannot be opened or offered for
--    requests by hand, by the robot or through the API. The same numbers
--    live in data/blocked-areas.json (the build and the robot read that);
--    tests/static.mjs fails if the two differ.
--
-- Data + one trigger function; safe to re-run.

do $$
declare
  cid uuid; s text;
begin
  foreach s in array array['knoxville', 'asheville'] loop
    select id into cid from public.cities where slug = s;
    if cid is null then
      raise notice '% already removed', s;
      continue;
    end if;

    -- Children of posts first (posts has no cascade). Vibes and take
    -- reviews follow their take.
    delete from public.vibe_tags where city_id = cid
        or post_id in (select id from public.posts where city_id = cid)
        or restaurant_id in (select id from public.restaurants where city_id = cid);
    delete from public.votes    where post_id in (select id from public.posts where city_id = cid);
    delete from public.comments where post_id in (select id from public.posts where city_id = cid);
    delete from public.posts    where city_id = cid;

    -- Restaurants / top 3 and the places catalogue.
    delete from public.top3_picks     where city_id = cid;
    delete from public.restaurants    where city_id = cid;
    delete from public.places_catalog where city_id = cid;

    -- Questions and their votes, calendar, places, locals.
    delete from public.question_votes where question_id in (select id from public.questions where city_id = cid);
    delete from public.questions      where city_id = cid;
    delete from public.city_events    where city_id = cid;
    delete from public.places         where city_id = cid;
    delete from public.local_checks   where city_id = cid;
    delete from public.city_tenure    where city_id = cid;
    delete from public.contributor_locality where city_id = cid;
    update public.email_signups set city_id = null where city_id = cid;

    delete from public.cities where id = cid;
    raise notice '% removed', s;
  end loop;
end $$;

-- The area rule. Longitude lines, drawn generously: Tennessee east of -85.7
-- (Chattanooga, Knoxville, the Tri-Cities, Gatlinburg) and North Carolina
-- west of -81.0 (Asheville, Boone, Hickory; Charlotte is east of the line).
create or replace function public.tv_block_area() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if (upper(new.state) = 'TN' and new.lng > -85.7)
  or (upper(new.state) = 'NC' and new.lng < -81.0) then
    raise exception 'AREA_NOT_COVERED' using errcode = 'P0001';
  end if;
  return new;
end $fn$;
revoke execute on function public.tv_block_area() from public, anon, authenticated;

drop trigger if exists trg_cities_block_area on public.cities;
create trigger trg_cities_block_area before insert or update of state, lat, lng on public.cities
  for each row execute function public.tv_block_area();
drop trigger if exists trg_city_candidates_block_area on public.city_candidates;
create trigger trg_city_candidates_block_area before insert or update of state, lat, lng on public.city_candidates
  for each row execute function public.tv_block_area();

-- Nothing in the request list is inside the area today (it holds the 100
-- largest US cities); this keeps it true if the list is ever reloaded.
delete from public.city_requests where city_slug in (
  select slug from public.city_candidates
   where (upper(state) = 'TN' and lng > -85.7) or (upper(state) = 'NC' and lng < -81.0));
delete from public.city_candidates
 where (upper(state) = 'TN' and lng > -85.7) or (upper(state) = 'NC' and lng < -81.0);
delete from public.city_requests where city_slug in ('knoxville', 'asheville');
