-- City requests: visitors ask for a city we don't cover yet.
-- Only the 100 largest US cities (Census 2024 estimates) can be requested,
-- so no tiny towns. A city opens when enough people ask (see OPEN_AT in
-- assets/tv-request.js); opening is a manual insert into cities.

create table if not exists public.city_candidates (
  slug        text primary key,
  name        text not null,
  state       text not null,
  lat         double precision not null,
  lng         double precision not null,
  population  integer not null,
  pop_rank    smallint not null
);
alter table public.city_candidates enable row level security;
drop policy if exists city_candidates_read on public.city_candidates;
create policy city_candidates_read on public.city_candidates for select using (true);

create table if not exists public.city_requests (
  city_slug   text not null references public.city_candidates(slug) on delete cascade,
  user_id     uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  primary key (city_slug, user_id)
);
alter table public.city_requests enable row level security;
drop policy if exists city_requests_insert on public.city_requests;
create policy city_requests_insert on public.city_requests for insert
  with check (auth.uid() = user_id);
drop policy if exists city_requests_read_own on public.city_requests;
create policy city_requests_read_own on public.city_requests for select
  using (auth.uid() = user_id);

-- 5 requests per person per day; stops one browser spamming a city up.
create or replace function public.city_requests_limit() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if (select count(*) from city_requests
       where user_id = new.user_id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'RATE_LIMITED';
  end if;
  return new;
end $fn$;
drop trigger if exists city_requests_limit on public.city_requests;
create trigger city_requests_limit before insert on public.city_requests
  for each row execute function public.city_requests_limit();

-- Public tallies only (never who asked).
create or replace view public.city_request_counts
with (security_invoker = false) as
  select c.slug, c.name, c.state, c.pop_rank, count(r.user_id)::int as requests
  from public.city_candidates c
  left join public.city_requests r on r.city_slug = c.slug
  where not exists (select 1 from public.cities x where x.slug = c.slug)
  group by c.slug, c.name, c.state, c.pop_rank;
grant select on public.city_request_counts to anon, authenticated;
