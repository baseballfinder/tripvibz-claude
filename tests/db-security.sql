-- Database security lint. READ-ONLY: it only queries the Postgres catalogs and
-- raises an error when a rule is broken. Run by tests.yml with the
-- SUPABASE_DB_URL secret:   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/db-security.sql
--
-- Rules, in plain words:
--   1. Row Level Security is on for every table the API can reach.
--   2. No table lets everyone write to it (no INSERT/UPDATE/DELETE policy that is just "true").
--   3. Functions that run with elevated rights (SECURITY DEFINER) pin their
--      search_path, and only the known ones can be called by visitors.
--   4. A person can't make themselves an admin by editing their profile.
--   5. (after migration 20261029174500) the tamper guards exist: vote counts,
--      moderation status and badges are locked, calendar entries from visitors
--      wait for review, text fields have size limits, the location table hides
--      its detail columns, and the API roles can't TRUNCATE.
--
-- Checks under 5 are skipped with a NOTICE until that migration has been
-- applied (merging the pull request applies it), so this file never blocks the
-- very pull request that ships the fix.

\set ON_ERROR_STOP on
\pset pager off

do $lint$
declare
  v_fail text := '';
  v_rows text;
  v_hardened boolean;
  v_allowed_anon_definer text[] := array['email_signup', 'is_admin', 'question_results'];
begin
  -- 1. RLS on every public table
  select string_agg(tablename, ', ') into v_rows
    from pg_tables where schemaname = 'public' and not rowsecurity;
  if v_rows is not null then v_fail := v_fail || E'\n  RLS disabled on: ' || v_rows; end if;

  -- 2. No write policy that is simply "true"
  select string_agg(tablename || '.' || policyname, ', ') into v_rows
    from pg_policies
   where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and (coalesce(qual, 'true') = 'true' and coalesce(with_check, 'true') = 'true');
  if v_rows is not null then v_fail := v_fail || E'\n  write policy open to everyone: ' || v_rows; end if;

  -- 3a. SECURITY DEFINER functions must pin search_path
  select string_agg(p.proname, ', ') into v_rows
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v_rows is not null then v_fail := v_fail || E'\n  SECURITY DEFINER without search_path: ' || v_rows; end if;

  -- 3b. Only the known SECURITY DEFINER functions are callable by visitors (anon)
  select string_agg(p.proname, ', ') into v_rows
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.proname <> all (v_allowed_anon_definer)
     and p.prorettype <> 'trigger'::regtype;
  if v_rows is not null then v_fail := v_fail || E'\n  SECURITY DEFINER callable by anon but not in the allow-list: ' || v_rows; end if;

  -- 4. Self-promotion to admin is blocked by the profile update policy
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
                   and cmd = 'UPDATE' and with_check ilike '%is_admin%') then
    v_fail := v_fail || E'\n  profiles UPDATE policy no longer guards is_admin';
  end if;

  -- 5. Guards from migration 20261029174500 (skipped until it is applied)
  select exists (select 1 from supabase_migrations.schema_migrations where version = '20261029174500') into v_hardened;
  if not v_hardened then
    raise notice 'db-security: migration 20261029174500_security_hardening not applied yet - skipping the tamper-guard checks';
  else
    select string_agg(t, ', ') into v_rows from unnest(array[
        'posts:trg_posts_lock_status', 'posts:trg_posts_lock_verified', 'posts:trg_posts_lock_protected',
        'comments:trg_comments_lock_protected', 'city_events:trg_city_events_guard',
        'votes:trg_votes_lock_target', 'profiles:trg_profiles_lock_protected']) t
     where not exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                        where c.relname = split_part(t, ':', 1) and tg.tgname = split_part(t, ':', 2) and not tg.tgisinternal);
    if v_rows is not null then v_fail := v_fail || E'\n  missing tamper-guard trigger: ' || v_rows; end if;

    select string_agg(c, ', ') into v_rows from unnest(array[
        'posts_title_len', 'posts_body_len', 'comments_body_len', 'city_events_name_len', 'city_events_blurb_len']) c
     where not exists (select 1 from pg_constraint where conname = c);
    if v_rows is not null then v_fail := v_fail || E'\n  missing size limit: ' || v_rows; end if;

    if has_column_privilege('anon', 'public.local_checks', 'band', 'SELECT')
       or has_column_privilege('authenticated', 'public.local_checks', 'checked_at', 'SELECT') then
      v_fail := v_fail || E'\n  local_checks detail columns (band, checked_at) are readable through the API';
    end if;

    select string_agg(tablename, ', ') into v_rows
      from pg_tables where schemaname = 'public'
       and (has_table_privilege('anon', format('public.%I', tablename), 'TRUNCATE')
         or has_table_privilege('authenticated', format('public.%I', tablename), 'TRUNCATE'));
    if v_rows is not null then v_fail := v_fail || E'\n  API roles can TRUNCATE: ' || v_rows; end if;

    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contributor_locality'
                 and cmd = 'SELECT' and coalesce(qual, 'true') = 'true') then
      v_fail := v_fail || E'\n  contributor_locality is readable by everyone';
    end if;
  end if;

  if v_fail <> '' then
    raise exception 'db-security: FAILED%', v_fail;
  end if;
  raise notice 'db-security: OK (hardening migration applied: %)', v_hardened;
end $lint$;
