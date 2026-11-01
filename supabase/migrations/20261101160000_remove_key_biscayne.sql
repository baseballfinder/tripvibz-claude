-- Remove Key Biscayne from TripVibz (James, 2026-11-01). It is a village
-- inside the Miami area, and the Miami page covers it; its old URLs
-- redirect there (data/removed-cities.json -> _redirects).
--
-- What goes: the city row and everything hanging off it. At the time of
-- writing that was 1 rejected test take, 9 questions (no votes), 6 calendar
-- entries, 2 places, 1 unverified local check and 705 places-catalogue rows.
-- The editorial rows are saved in data/removed/key-biscayne-2026-11-01.json.
-- Data-only; safe to re-run (every statement matches nothing once the city
-- is gone).
do $$
declare
  cid uuid := (select id from public.cities where slug = 'key-biscayne');
begin
  if cid is null then
    raise notice 'key-biscayne already removed';
    return;
  end if;

  -- Children of posts first (posts has no cascade).
  delete from public.votes    where post_id in (select id from public.posts where city_id = cid);
  delete from public.comments where post_id in (select id from public.posts where city_id = cid);
  delete from public.posts    where city_id = cid;

  -- Restaurants / top 3 (none today, but the city may have gained some).
  delete from public.top3_picks  where city_id = cid;
  delete from public.restaurants where city_id = cid;
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
  raise notice 'key-biscayne removed';
end $$;
