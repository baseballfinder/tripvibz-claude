-- The cities page showed "Needs locals — be the first" for cities with takes.
-- cities_with_counts only counted takes attached to a mapped place (posts.place_id),
-- but takes from questions and the add page carry city_id + a free-text place label.
-- Count takes by city instead. Column list and order unchanged.
create or replace view public.cities_with_counts with (security_invoker = true) as
select c.id, c.name, c.state, c.slug, c.lat, c.lng, c.blurb, c.sort,
       coalesce(pc.place_count, 0::bigint) as place_count,
       coalesce(tc.take_count, 0::bigint) as take_count,
       c.photo
from cities c
left join (select p.city, count(*) as place_count
           from places p where p.city is not null group by p.city) pc on pc.city = c.name
left join (select po.city_id, count(*) as take_count
           from posts po where po.status = 'approved' group by po.city_id) tc on tc.city_id = c.id;
