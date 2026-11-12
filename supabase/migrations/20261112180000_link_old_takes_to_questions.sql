-- Takes posted before the add page switched to the city's preset questions
-- (PR #89) answer those questions but carry no question_id, so the add page
-- can't show "Your take" on the card or list them under "Already said", and
-- people end up repeating them. Link each one to the active question it
-- answers (its title starts with that question's subject and the answer).
-- Data only, idempotent: rows already linked, or gone, are left alone.
-- Not linked: Fort Lauderdale "Avoid Fort Lauderdale in summer…" (answers the
-- retired "Worst month" question, not one that is active now).
update public.posts p
set question_id = m.q
from (values
  -- Knoxville
  ('f7898aa2-7efa-4c6b-ab73-85dadf6544a7'::uuid, '591798f3-c670-477d-b24e-5ef600d8cadf'::uuid), -- UT home game weekend -> Neyland Stadium on game day
  ('67a0178a-8eab-4bfe-af30-34ab54ccff59'::uuid, '591798f3-c670-477d-b24e-5ef600d8cadf'::uuid), -- Neyland Stadium on game day
  ('8ef3adb6-5691-4bce-8c67-93935d1fe69c'::uuid, '19fd2eea-4822-47ad-a51a-371028feef56'::uuid), -- Visiting the Smokies
  ('e07f9002-d53c-43a8-8cf6-598eb0a8f771'::uuid, '7357db8b-107d-4f01-a671-203fc3e9fe5a'::uuid), -- Market Square on a Saturday
  ('02ca37da-6576-4efd-b574-d0bb6a8b8aeb'::uuid, 'a7769bcc-79af-4f60-bb05-ac8f126d9660'::uuid), -- Old City at night
  -- Fort Lauderdale
  ('ea75f3eb-4bf4-4baf-828e-dcdf5e1573f4'::uuid, '56b99f32-a26e-4949-be0f-8d30b0a36ea5'::uuid), -- Las Olas on a Saturday night
  ('9aab4a41-0d94-43b6-aea8-69eaa0984bf2'::uuid, 'cc76114f-e228-4880-a18b-f8290df28bc4'::uuid), -- Water Taxi
  ('76e3328d-83dc-4f1d-9703-8e91abaf452c'::uuid, '8695d6fe-847c-4c2a-83c5-861f9063d8cf'::uuid), -- Weekend: rent a car
  ('9f8fc33d-04e9-4fa7-aa03-e93604fad8f1'::uuid, 'e434fde4-d45a-4956-8823-97a7a80d4c34'::uuid), -- Best time (Winter)
  -- Miami
  ('6da51436-ddce-46fa-abdf-45cf21344904'::uuid, 'b9e5eb4a-8890-4475-90f8-616cfec31e84'::uuid), -- Little Havana
  ('33f4d754-5755-4778-8d38-45e62f79f5b3'::uuid, '8ef483ce-87bb-4f0c-8f5e-51796115d421'::uuid), -- Wynwood Walls
  ('e8534a4f-a0b7-4215-b154-5d0bb92d9c6a'::uuid, '7eb2d4bd-0d4d-476c-84dd-d62a4753a16b'::uuid), -- Without a car
  ('e8c4e312-be02-4cf0-b830-a0c648a18447'::uuid, 'e722c8b6-06cf-4269-a1da-e23903d4861d'::uuid)  -- Best time (Winter)
) as m(p, q)
join public.questions qq on qq.id = m.q and qq.active
where p.id = m.p
  and p.question_id is null
  and p.city_id = qq.city_id;
