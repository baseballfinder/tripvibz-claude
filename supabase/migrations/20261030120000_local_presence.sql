-- Local verification v2: presence over time, not a single reading.
--
-- Before: a signed-in person got a ✓ when their LAST daily check (Cloudflare's
-- rough location for the connection) was within 40 miles of the city. One
-- afternoon in town, or one VPN exit, was enough, and the ✓ vanished when a
-- real local travelled. Any Google sign-in was also labelled "Local".
--
-- Now: each day a signed-in person visits or posts from near a city counts as
-- one presence day (functions/api/locate.js, through record_presence below).
-- "verified" = several distinct days spread over weeks — thresholds live in
-- tv_local_verified() and nowhere else. The public reads only verified/revoked;
-- the day count and dates are admin-only (admin_local_checks), so nobody can
-- watch their own progress toward the badge. An admin's revoke still stands:
-- record_presence never touches a revoked row, and the badge never returns on
-- its own. Founding local now requires the ✓ too.
--
-- Privacy unchanged: near/not-near per city and a count of days; no IP, no
-- coordinates. The public page /how-we-verify-locals/ describes the method.

-- 1. Presence columns + the stored verdict.
alter table public.local_checks
  add column if not exists near_days  integer     not null default 0,
  add column if not exists first_near timestamptz,
  add column if not exists last_near  timestamptz,
  add column if not exists verified   boolean     not null default false;

-- Checks from hosting / VPN networks are kept for admins but never count as presence.
alter table public.local_checks drop constraint if exists local_checks_band_check;
alter table public.local_checks add constraint local_checks_band_check
  check (band is null or band in ('near', 'region', 'far', 'hosting'));

-- Backfill: a row that was "near" at its last check is one presence day.
update public.local_checks
   set near_days = 1, first_near = checked_at, last_near = checked_at
 where near and near_days = 0;

-- 2. The rule, in one place. Immutable so it can run in a trigger and in tests.
create or replace function public.tv_local_verified(p_days integer, p_first timestamptz, p_last timestamptz, p_revoked boolean)
returns boolean language sql immutable set search_path = public as $fn$
  select coalesce(p_days, 0) >= 3
     and p_first is not null and p_last is not null
     and p_last - p_first >= interval '21 days'
     and not coalesce(p_revoked, false);
$fn$;
revoke execute on function public.tv_local_verified(integer, timestamptz, timestamptz, boolean) from public, anon, authenticated;

-- SECURITY DEFINER so the rule function above can stay unexecutable by the API
-- roles (an admin's revoke runs this trigger as "authenticated").
create or replace function public.local_checks_set_verified()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  new.verified := public.tv_local_verified(new.near_days, new.first_near, new.last_near, new.revoked);
  if new.revoked and new.revoked_at is null then new.revoked_at := now(); end if;
  return new;
end $fn$;
drop trigger if exists trg_local_checks_verified on public.local_checks;
create trigger trg_local_checks_verified before insert or update on public.local_checks
  for each row execute function public.local_checks_set_verified();

update public.local_checks set near_days = near_days;   -- run the trigger once over existing rows

-- 3. Recording a check. Server-only (service role from functions/api/locate.js).
--    A new calendar day near the city adds one presence day; the same day twice
--    does not. Revoked rows are left exactly as the admin set them.
create or replace function public.record_presence(p_user uuid, p_city uuid, p_near boolean, p_band text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if p_band is not null and p_band not in ('near', 'region', 'far', 'hosting') then
    raise exception 'bad band' using errcode = '22023';
  end if;
  insert into public.local_checks as lc (user_id, city_id, near, band, checked_at, near_days, first_near, last_near)
  values (p_user, p_city, p_near, p_band, now(),
          case when p_near then 1 else 0 end,
          case when p_near then now() end,
          case when p_near then now() end)
  on conflict (user_id, city_id) do update
     set near       = excluded.near,
         band       = excluded.band,
         checked_at = now(),
         near_days  = lc.near_days
                      + case when excluded.near and (lc.last_near is null or lc.last_near < date_trunc('day', now()))
                             then 1 else 0 end,
         first_near = coalesce(lc.first_near, case when excluded.near then now() end),
         last_near  = case when excluded.near then now() else lc.last_near end
   where not lc.revoked;
end $fn$;
revoke execute on function public.record_presence(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.record_presence(uuid, uuid, boolean, text) to service_role;

-- 4. What the public can read: who is verified / revoked, nothing about progress.
revoke all on public.local_checks from anon, authenticated;
grant select (user_id, city_id, verified, revoked) on public.local_checks to anon, authenticated;
-- Admins revoke/restore from admin.html (RLS limits the write to admins; the trigger recomputes verified).
grant insert (user_id, city_id, near, revoked, revoked_at), update (revoked, revoked_at) on public.local_checks to authenticated;
grant all on public.local_checks to service_role;

-- Admin detail: the presence history behind a badge, for the people in a list.
create or replace function public.admin_local_checks(p_users uuid[])
returns table (user_id uuid, city_id uuid, near boolean, band text, near_days integer,
               first_near timestamptz, last_near timestamptz, checked_at timestamptz,
               verified boolean, revoked boolean, revoked_at timestamptz)
language sql stable security definer set search_path = public as $fn$
  select lc.user_id, lc.city_id, lc.near, lc.band, lc.near_days, lc.first_near, lc.last_near, lc.checked_at,
         lc.verified, lc.revoked, lc.revoked_at
    from public.local_checks lc
   where public.is_admin() and lc.user_id = any (p_users);
$fn$;
revoke execute on function public.admin_local_checks(uuid[]) from public, anon;
grant execute on function public.admin_local_checks(uuid[]) to authenticated, service_role;

-- 5. Founding local = one of the first ten VERIFIED locals to post in a city.
create or replace view public.city_founders with (security_invoker = true) as
select city_id, author_id, first_post, rank from (
  select p.city_id, p.author_id, min(p.created_at) as first_post,
         row_number() over (partition by p.city_id order by min(p.created_at)) as rank
    from public.posts p
   where p.author_verified and p.status = 'approved' and p.author_id is not null
     and exists (select 1 from public.local_checks lc
                  where lc.user_id = p.author_id and lc.city_id = p.city_id and lc.verified)
   group by p.city_id, p.author_id
) x where rank <= 10;
grant select on public.city_founders to anon, authenticated, service_role;
