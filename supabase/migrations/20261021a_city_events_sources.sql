-- Track where each calendar entry came from and when it was last checked, so the
-- monthly events check (skill: tripvibz-events-check) can re-verify stale or
-- upcoming entries. Columns only; no new tables or views, so no new grants needed.
alter table public.city_events
  add column if not exists source      text,          -- URL the timing was verified against
  add column if not exists verified_at timestamptz,   -- last time someone checked it against the source
  add column if not exists check_note  text;          -- e.g. "2027 dates not announced yet"
create index if not exists city_events_verified_at_idx on public.city_events (verified_at nulls first);
