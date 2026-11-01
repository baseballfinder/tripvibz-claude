-- Nashville calendar: Gaylord Opryland's "A Country Christmas" runs Nov 6, 2026
-- to Jan 2, 2027 (43rd year), so the busy window is Nov–Jan, not Nov–Dec.
-- Source: Visit Music City press release (events check, 2026-11-01).
--
-- Data-only. Already applied to the live database by hand on 2026-11-01;
-- re-running is harmless (same values, verified_at moves to the run time).
update public.city_events
set end_month = 1,
    source = 'https://www.visitmusiccity.com/media/press-release/2026/gaylord-opryland-announces-43rd-annual-a-country-christmas-showcasing',
    verified_at = now(),
    check_note = '2026-27 run: Nov 6 - Jan 2'
where id = '26ad66c4-db3d-4b8b-916a-3dd774f03179';
