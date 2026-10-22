-- "Signed in nearby" check for locals (low friction: no prompt, no location permission).
-- When a signed-in person loads the site, /api/locate reads Cloudflare's rough
-- location for the connection, works out which TripVibz cities are within 40 miles,
-- and records only near / not near per city. No IP address, no coordinates.
-- Takes from people who signed in nearby show "Local ✓". An admin can revoke a
-- person's local status for a city (spam, obvious out-of-towner); revoked shows
-- "Unverified". Written only by the server (service role) and admins.
create table if not exists public.local_checks (
  user_id    uuid not null references auth.users(id) on delete cascade,
  city_id    uuid not null references public.cities(id) on delete cascade,
  near       boolean not null,
  band       text check (band in ('near','region','far')),   -- admin-only detail
  checked_at timestamptz not null default now(),
  revoked    boolean not null default false,
  revoked_at timestamptz,
  primary key (user_id, city_id)
);
alter table public.local_checks enable row level security;

drop policy if exists "read local checks" on public.local_checks;
create policy "read local checks" on public.local_checks for select using (true);
drop policy if exists "admins manage local checks" on public.local_checks;
create policy "admins manage local checks" on public.local_checks for all
  using (public.is_admin()) with check (public.is_admin());

-- Explicit Data API grants (required for new tables from Oct 30, 2026).
-- Everyone can see near/revoked (that's what the badge shows). The distance band
-- isn't granted to anyone but the server: James sees distances in the phone alerts.
revoke all on public.local_checks from anon, authenticated;
grant select (user_id, city_id, near, revoked, checked_at) on public.local_checks to anon, authenticated;
-- Admins revoke/restore from admin.html; RLS limits these writes to admins.
grant insert (user_id, city_id, near, revoked, revoked_at), update (revoked, revoked_at) on public.local_checks to authenticated;
grant all on public.local_checks to service_role;
