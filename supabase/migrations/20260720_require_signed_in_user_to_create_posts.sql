-- Require a signed-in (non-anonymous) identity to create a post.
--
-- Before this, the INSERT policy was `auth.uid() = author_id`. Anonymous
-- sessions have a valid auth.uid(), so anyone could create posts straight
-- against the API without ever signing in -- the UI gate was cosmetic.
--
-- Anonymous sessions keep read, vote, and comment access. The auth.uid() =
-- author_id half still prevents attributing a post to someone else.

drop policy if exists "insert own post" on public.posts;

create policy "insert own post" on public.posts
  for insert
  with check (
    auth.uid() = author_id
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is false
  );
