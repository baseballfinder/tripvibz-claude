-- TripVibz feed v2 (Oct 17, 2026)
-- Adds: editorial questions + one-tap answers, anonymous posting (rate limited,
-- marked unverified), place/month tags on takes, per-city tenure badge, typed
-- replies, founding-locals view, and a claim flow that moves anonymous takes
-- to a Google account after sign-in. Additive except one replaced policy:
-- "insert own post" no longer blocks anonymous sessions.
-- Run once in Supabase → SQL editor. Safe to re-run.

create or replace function public.jwt_is_verified()
returns boolean language sql stable set search_path = public as $fn$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is false
$fn$;

alter table public.posts
  add column if not exists months smallint[],
  add column if not exists place_label text check (place_label is null or char_length(place_label) <= 60),
  add column if not exists author_verified boolean not null default false;

alter table public.posts drop constraint if exists posts_months_valid;
alter table public.posts add constraint posts_months_valid
  check (months is null or (months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[] and cardinality(months) between 1 and 12));

-- Existing signed-in takes count as verified.
update public.posts p set author_verified = true
  where author_id is not null and author_verified = false
    and exists (select 1 from auth.users u where u.id = p.author_id and coalesce(u.is_anonymous, false) = false);

create or replace function public.posts_stamp_author()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare n int; lim int := 3;
begin
  new.author_verified := (new.author_id is not null and public.jwt_is_verified());
  if new.author_verified then lim := 20; end if;
  if new.author_id is not null then
    select count(*) into n from public.posts
      where author_id = new.author_id and created_at > now() - interval '24 hours';
    if n >= lim then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_posts_stamp_author on public.posts;
create trigger trg_posts_stamp_author before insert on public.posts
  for each row execute function public.posts_stamp_author();

create or replace function public.posts_lock_verified()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if new.author_verified is distinct from old.author_verified and not public.is_admin()
     and current_setting('tv.claiming', true) is distinct from 'on' then
    new.author_verified := old.author_verified;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_posts_lock_verified on public.posts;
create trigger trg_posts_lock_verified before update on public.posts
  for each row execute function public.posts_lock_verified();

drop policy if exists "insert own post" on public.posts;
create policy "insert own post" on public.posts for insert
  with check (auth.uid() = author_id);

alter table public.comments
  add column if not exists kind text check (kind in ('agree','context','disagree')),
  add column if not exists author_verified boolean not null default false;

create or replace function public.comments_stamp_author()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare n int; lim int := 10;
begin
  new.author_verified := (new.author_id is not null and public.jwt_is_verified());
  if new.author_verified then lim := 60; end if;
  if new.author_id is not null then
    select count(*) into n from public.comments
      where author_id = new.author_id and created_at > now() - interval '24 hours';
    if n >= lim then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_comments_stamp_author on public.comments;
create trigger trg_comments_stamp_author before insert on public.comments
  for each row execute function public.comments_stamp_author();

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete cascade,
  prompt text not null check (char_length(prompt) between 8 and 160),
  options jsonb not null,
  place_label text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists questions_city_idx on public.questions(city_id, active, sort);
alter table public.questions enable row level security;
drop policy if exists "read questions" on public.questions;
create policy "read questions" on public.questions for select using (active or public.is_admin());
drop policy if exists "admin write questions" on public.questions;
create policy "admin write questions" on public.questions for all using (public.is_admin()) with check (public.is_admin());

create table if not exists public.question_votes (
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id uuid not null,
  option_id text not null check (char_length(option_id) <= 24),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (question_id, user_id)
);
alter table public.question_votes enable row level security;
drop policy if exists "read own answers" on public.question_votes;
create policy "read own answers" on public.question_votes for select using (auth.uid() = user_id);
drop policy if exists "answer as self" on public.question_votes;
create policy "answer as self" on public.question_votes for insert with check (auth.uid() = user_id);
drop policy if exists "change own answer" on public.question_votes;
create policy "change own answer" on public.question_votes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.question_votes_check()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from public.questions q, jsonb_array_elements(q.options) o
                 where q.id = new.question_id and q.active and o->>'id' = new.option_id) then
    raise exception 'BAD_OPTION' using errcode = 'P0001';
  end if;
  new.verified := public.jwt_is_verified();
  return new;
end $fn$;
drop trigger if exists trg_question_votes_check on public.question_votes;
create trigger trg_question_votes_check before insert or update on public.question_votes
  for each row execute function public.question_votes_check();

create or replace function public.question_results(qids uuid[])
returns table(question_id uuid, option_id text, n bigint, verified_n bigint)
language sql stable security definer set search_path = public as $fn$
  select v.question_id, v.option_id, count(*), count(*) filter (where v.verified)
  from public.question_votes v
  join public.questions q on q.id = v.question_id and q.active
  where v.question_id = any(qids)
  group by v.question_id, v.option_id
$fn$;

create table if not exists public.city_tenure (
  user_id uuid not null references public.profiles(id) on delete cascade,
  city_id uuid not null references public.cities(id) on delete cascade,
  tenure text not null check (tenure in ('lt1','1-5','5-10','10+','grew_up','visitor')),
  created_at timestamptz not null default now(),
  primary key (user_id, city_id)
);
alter table public.city_tenure enable row level security;
drop policy if exists "read tenure" on public.city_tenure;
create policy "read tenure" on public.city_tenure for select using (true);
drop policy if exists "set own tenure" on public.city_tenure;
create policy "set own tenure" on public.city_tenure for insert with check (auth.uid() = user_id);
drop policy if exists "change own tenure" on public.city_tenure;
create policy "change own tenure" on public.city_tenure for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace view public.city_founders with (security_invoker = true) as
select city_id, author_id, first_post, rank from (
  select city_id, author_id, min(created_at) as first_post,
         row_number() over (partition by city_id order by min(created_at)) as rank
  from public.posts
  where author_verified and status = 'approved' and author_id is not null
  group by city_id, author_id
) x where rank <= 10;

create table if not exists public.claims (
  token text primary key,
  anon_user_id uuid not null,
  expires_at timestamptz not null default now() + interval '1 hour'
);
alter table public.claims enable row level security;

create or replace function public.create_claim()
returns text language plpgsql security definer set search_path = public, extensions as $fn$
declare t text;
begin
  if auth.uid() is null or public.jwt_is_verified() then
    raise exception 'ONLY_ANONYMOUS' using errcode = 'P0001';
  end if;
  delete from public.claims where anon_user_id = auth.uid() or expires_at < now();
  t := encode(gen_random_bytes(24), 'hex');
  insert into public.claims(token, anon_user_id) values (t, auth.uid());
  return t;
end $fn$;

create or replace function public.redeem_claim(tok text)
returns int language plpgsql security definer set search_path = public as $fn$
declare a uuid; me uuid := auth.uid(); moved int := 0;
begin
  if me is null or not public.jwt_is_verified() then
    raise exception 'SIGN_IN_FIRST' using errcode = 'P0001';
  end if;
  delete from public.claims where token = tok and expires_at > now() returning anon_user_id into a;
  if a is null or a = me then return 0; end if;
  perform set_config('tv.claiming', 'on', true);
  update public.posts set author_id = me, author_verified = true where author_id = a;
  get diagnostics moved = row_count;
  update public.comments set author_id = me, author_verified = true where author_id = a;
  delete from public.votes v where v.user_id = a and exists (select 1 from public.votes w where w.user_id = me and w.post_id = v.post_id);
  update public.votes set user_id = me where user_id = a;
  delete from public.question_votes v where v.user_id = a and exists (select 1 from public.question_votes w where w.user_id = me and w.question_id = v.question_id);
  update public.question_votes set user_id = me, verified = true where user_id = a;
  insert into public.city_tenure(user_id, city_id, tenure, created_at)
    select me, city_id, tenure, created_at from public.city_tenure where user_id = a
    on conflict (user_id, city_id) do nothing;
  delete from public.city_tenure where user_id = a;
  return moved;
end $fn$;

revoke execute on function public.posts_stamp_author() from public, anon, authenticated;
revoke execute on function public.posts_lock_verified() from public, anon, authenticated;
revoke execute on function public.comments_stamp_author() from public, anon, authenticated;
revoke execute on function public.question_votes_check() from public, anon, authenticated;
revoke execute on function public.create_claim() from public, anon;
revoke execute on function public.redeem_claim(text) from public, anon;
grant execute on function public.create_claim() to authenticated;
grant execute on function public.redeem_claim(text) to authenticated;
grant execute on function public.question_results(uuid[]) to anon, authenticated;
grant select on public.questions, public.city_tenure, public.city_founders to anon, authenticated;
grant select, insert, update on public.question_votes to authenticated;
grant insert, update on public.city_tenure to authenticated;
