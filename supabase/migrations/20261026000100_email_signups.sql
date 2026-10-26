-- Email signups for the TripVibz newsletter (Kit).
--
-- People opt in with the "Get <City> tips by email" box on city pages and after
-- they post a take. The browser can only call email_signup(); it can never read
-- this table. A GitHub Action (kit-sync.yml, hourly) reads new rows with the
-- database URL and adds each person to the TripVibz Kit account with a city tag,
-- using the KIT_API_KEY repo secret. The Kit key never reaches the browser.

create table if not exists public.email_signups (
  id         bigint generated always as identity primary key,
  email      text not null check (length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  city_id    uuid references public.cities(id) on delete set null,
  source     text not null default 'site' check (source ~ '^[a-z0-9_-]{1,40}$'),
  user_id    uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  synced_at  timestamptz,           -- set when Kit accepted the subscriber
  attempts   int not null default 0,
  sync_error text                   -- last Kit error, no email in it
);

-- One row per email per city (a person can follow several cities).
create unique index if not exists email_signups_email_city
  on public.email_signups (email, coalesce(city_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists email_signups_unsynced
  on public.email_signups (created_at) where synced_at is null;

alter table public.email_signups enable row level security;
-- No policies: nobody but the server (service role / database URL) reads or writes rows.
revoke all on public.email_signups from anon, authenticated;
grant all on public.email_signups to service_role;

-- The only door in from the browser. Lowercases the address, ignores repeats,
-- and limits each visitor session to 5 signups a day.
create or replace function public.email_signup(p_email text, p_city uuid default null, p_source text default 'site')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_uid   uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NO_SESSION';
  end if;
  if length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'BAD_EMAIL';
  end if;
  if (select count(*) from public.email_signups
       where user_id = v_uid and created_at > now() - interval '1 day') >= 5 then
    raise exception 'RATE_LIMITED';
  end if;
  insert into public.email_signups (email, city_id, source, user_id)
  values (v_email, p_city,
          case when coalesce(p_source, '') ~ '^[a-z0-9_-]{1,40}$' then p_source else 'site' end,
          v_uid)
  on conflict do nothing;
end;
$$;

revoke all on function public.email_signup(text, uuid, text) from public;
grant execute on function public.email_signup(text, uuid, text) to anon, authenticated;
