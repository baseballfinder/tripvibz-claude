-- Site log: visits and errors as they happen, for the owner's admin page.
--
-- Until now a browser error or a search visit only became a phone notification
-- and was gone. This table keeps them for 30 days so the admin page can show a
-- live list and a history: one row per visit start, page view, page leave,
-- browser error, failed save or request, Function failure, slow Function
-- response and missing page.
--
-- Who writes: only the server (functions/api/_log.js, with the service key).
-- Who reads: only admins, through admin_site_log(). Visitors and signed-in
-- people can neither read nor write it: RLS is on with no policy.
--
-- Privacy: no IP address, no account id, no name. session_id is a random id the
-- browser makes for one visit (sessionStorage, gone when the tab closes); place
-- is the rough city Cloudflare reports; device is phone / tablet / desktop / bot.
-- Rows older than 30 days are deleted nightly (.github/workflows/maintenance.yml).

create table if not exists public.site_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('visit', 'page', 'leave', 'error', 'request_failed', 'function_error', 'slow', 'not_found')),
  session_id text check (session_id is null or session_id ~ '^[a-z0-9]{8,32}$'),
  path       text check (path is null or char_length(path) <= 200),
  source     text check (source is null or char_length(source) <= 120),
  place      text check (place is null or char_length(place) <= 120),
  device     text check (device is null or device in ('phone', 'tablet', 'desktop', 'bot')),
  message    text check (message is null or char_length(message) <= 300),
  detail     text check (detail is null or char_length(detail) <= 800),
  status     integer check (status is null or status between 0 and 999),
  ms         integer check (ms is null or ms between 0 and 86400000)
);
create index if not exists site_log_at_idx on public.site_log (at desc);
create index if not exists site_log_session_idx on public.site_log (session_id) where session_id is not null;

alter table public.site_log enable row level security;   -- and no policy: the API roles get nothing
revoke all on public.site_log from public, anon, authenticated;
grant all on public.site_log to service_role;

-- The admin page's read. p_after = the newest id the page already has (it asks
-- again every few seconds for anything newer); p_since bounds the history.
create or replace function public.admin_site_log(p_after bigint default 0, p_since timestamptz default now() - interval '24 hours', p_limit integer default 500)
returns setof public.site_log
language sql stable security definer set search_path = public as $fn$
  select l.* from public.site_log l
   where public.is_admin() and l.id > coalesce(p_after, 0) and l.at >= coalesce(p_since, now() - interval '24 hours')
   order by l.id desc
   limit least(greatest(coalesce(p_limit, 500), 1), 2000);
$fn$;
revoke execute on function public.admin_site_log(bigint, timestamptz, integer) from public, anon;
grant execute on function public.admin_site_log(bigint, timestamptz, integer) to authenticated, service_role;
