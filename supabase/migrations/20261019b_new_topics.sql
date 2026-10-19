-- New topics people propose wait for review; question answers post instantly.
-- Run 20261019a_pending_status.sql first.

-- 1. What a take is about
alter table public.posts add column if not exists topic text
  check (topic is null or char_length(topic) between 3 and 120);
alter table public.posts add column if not exists question_id uuid
  references public.questions(id) on delete set null;
create index if not exists posts_author_city_q on public.posts (author_id, city_id, question_id);

-- 2. Status is never chosen by the person posting: new topics wait, everything else is live.
--    (Not security definer on purpose: current_user must be the caller, so the
--    website runs as anon/authenticated and the review bot as postgres.)
create or replace function public.posts_set_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return new; end if;
  new.status := case when new.topic is not null then 'pending'::moderation_status
                     else 'approved'::moderation_status end;
  return new;
end $$;
drop trigger if exists trg_posts_set_status on public.posts;
create trigger trg_posts_set_status before insert on public.posts
  for each row execute function public.posts_set_status();

-- ...and can't be changed by them afterwards (the review bot connects as postgres).
create or replace function public.posts_lock_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_admin()
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    new.status := old.status;
  end if;
  return new;
end $$;
drop trigger if exists trg_posts_lock_status on public.posts;
create trigger trg_posts_lock_status before update on public.posts
  for each row execute function public.posts_lock_status();
revoke execute on function public.posts_set_status() from anon, authenticated;
revoke execute on function public.posts_lock_status() from anon, authenticated;

-- People can see their own takes while they wait for review.
drop policy if exists "read own posts" on public.posts;
create policy "read own posts" on public.posts for select using (auth.uid() = author_id);

-- 3. Review notes for new topics (search + hashtag check). Bot-only table.
create table if not exists public.take_reviews (
  post_id uuid primary key references public.posts(id) on delete cascade,
  search_phrase text,
  bing_monthly integer,
  hashtag text,
  ig_posts bigint,
  rating text,
  issue_number integer,
  checked_at timestamptz not null default now()
);
alter table public.take_reviews enable row level security;
