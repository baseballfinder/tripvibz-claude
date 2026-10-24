-- Starter questions for the South Florida launch. These are TripVibz's own
-- questions (shown as "Locals, settle this"), not user content. Answers come
-- only from real votes. Run after 20261017_feed_v2.sql. Safe to re-run.

with q(slug, sort, prompt, place_label, options) as (values
  ('fort-lauderdale', 1, 'Las Olas on a Saturday night: worth it, or skip it?', 'Las Olas',
     '[{"id":"worth","label":"Worth it"},{"id":"skip","label":"Skip it"},{"id":"depends","label":"Depends on the night"}]'),
  ('fort-lauderdale', 2, 'Visiting for a weekend: rent a car, or skip it?', 'Whole city',
     '[{"id":"rent","label":"Rent one"},{"id":"skip","label":"Skip it"},{"id":"depends","label":"Depends where you stay"}]'),
  ('fort-lauderdale', 3, 'Is the water taxi worth it for visitors?', 'Water taxi',
     '[{"id":"yes","label":"Worth it"},{"id":"no","label":"Skip it"},{"id":"once","label":"Once, for the ride"}]'),
  ('fort-lauderdale', 4, 'Worst month to visit Fort Lauderdale?', 'Whole city',
     '[{"id":"mar","label":"March"},{"id":"aug","label":"August"},{"id":"sep","label":"September"},{"id":"none","label":"No bad month"}]'),
  ('fort-lauderdale', 5, 'Beach day: Fort Lauderdale Beach or drive to a quieter one?', 'A1A beachfront',
     '[{"id":"ftl","label":"Fort Lauderdale Beach"},{"id":"quieter","label":"Drive somewhere quieter"},{"id":"depends","label":"Depends on the day"}]'),

  ('miami', 1, 'First trip to Miami: stay in South Beach or somewhere else?', 'Whole city',
     '[{"id":"sobe","label":"South Beach"},{"id":"else","label":"Somewhere else"},{"id":"depends","label":"Depends on the trip"}]'),
  ('miami', 2, 'Visiting Miami without a car: doable, or a mistake?', 'Whole city',
     '[{"id":"doable","label":"Doable"},{"id":"mistake","label":"A mistake"},{"id":"depends","label":"Depends where you stay"}]'),
  ('miami', 3, 'Wynwood: worth the trip for visitors?', 'Wynwood',
     '[{"id":"yes","label":"Worth it"},{"id":"no","label":"Overrated"},{"id":"quick","label":"Quick stop only"}]'),
  ('miami', 4, 'Worst month to visit Miami?', 'Whole city',
     '[{"id":"mar","label":"March"},{"id":"aug","label":"August"},{"id":"sep","label":"September"},{"id":"dec","label":"Late December"}]'),
  ('miami', 5, 'Little Havana: real local spot or tourist trap now?', 'Little Havana',
     '[{"id":"real","label":"Still the real thing"},{"id":"trap","label":"Mostly for tourists"},{"id":"both","label":"Both, if you know where to go"}]'),

  ('miami-beach', 1, 'Ocean Drive for dinner: worth it, or skip it?', 'Ocean Drive',
     '[{"id":"worth","label":"Worth it once"},{"id":"skip","label":"Skip it"},{"id":"drinks","label":"Drinks only"}]'),
  ('miami-beach', 2, 'South Beach or Mid-Beach for a first visit?', 'Whole city',
     '[{"id":"south","label":"South Beach"},{"id":"mid","label":"Mid-Beach"},{"id":"north","label":"North Beach"}]'),
  ('miami-beach', 3, 'Driving to South Beach on a Saturday: fine, or never?', 'South Beach',
     '[{"id":"fine","label":"Fine"},{"id":"never","label":"Never"},{"id":"early","label":"Only if you go early"}]'),
  ('miami-beach', 4, 'Spring break week in Miami Beach: come, or avoid?', 'Whole city',
     '[{"id":"come","label":"Come anyway"},{"id":"avoid","label":"Avoid it"},{"id":"depends","label":"Depends what you want"}]'),

  ('key-biscayne', 1, 'Crossing the Rickenbacker on a Sunday afternoon: fine, or avoid?', 'Rickenbacker Causeway',
     '[{"id":"fine","label":"Fine"},{"id":"avoid","label":"Avoid it"},{"id":"early","label":"Go early or late"}]'),
  ('key-biscayne', 2, 'Key Biscayne for a beach day: worth the drive from Miami?', 'Whole island',
     '[{"id":"yes","label":"Worth it"},{"id":"no","label":"Not worth it"},{"id":"weekday","label":"Weekdays only"}]'),
  ('key-biscayne', 3, 'Biking the island: best way to see it, or overrated?', 'Whole island',
     '[{"id":"best","label":"Best way"},{"id":"overrated","label":"Overrated"},{"id":"heat","label":"Only when it''s not too hot"}]'),

  ('key-west', 1, 'Duval Street at night: worth it, or skip it?', 'Duval Street',
     '[{"id":"worth","label":"Worth it"},{"id":"skip","label":"Skip it"},{"id":"once","label":"Once, then move on"}]'),
  ('key-west', 2, 'Drive down from Miami, or fly in?', 'Getting there',
     '[{"id":"drive","label":"Drive"},{"id":"fly","label":"Fly"},{"id":"depends","label":"Depends on the season"}]'),
  ('key-west', 3, 'Sunset at Mallory Square: worth the crowd?', 'Mallory Square',
     '[{"id":"yes","label":"Worth it"},{"id":"no","label":"Skip the crowd"},{"id":"once","label":"Once"}]'),
  ('key-west', 4, 'Worst week to visit Key West?', 'Whole island',
     '[{"id":"fantasy","label":"Fantasy Fest"},{"id":"spring","label":"Spring break"},{"id":"newyear","label":"New Year''s"},{"id":"none","label":"No bad week"}]')
)
insert into public.questions (city_id, sort, prompt, place_label, options)
select c.id, q.sort, q.prompt, q.place_label, q.options::jsonb
from q join public.cities c on c.slug = q.slug
where not exists (select 1 from public.questions x where x.city_id = c.id and x.prompt = q.prompt);
