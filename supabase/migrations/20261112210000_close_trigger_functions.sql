-- Close the trigger functions to the API.
--
-- Postgres lets everyone EXECUTE a new function by default, and PostgREST lists
-- every function in "public" under /rest/v1/rpc/. Eleven trigger functions were
-- reachable that way (Supabase's security advisor names the three that run with
-- elevated rights: local_checks_set_verified, restaurants_rate_limit,
-- top3_picks_guard). Calling a trigger function directly always fails, so none
-- of them could do anything, but they have no business being on the API.
--
-- Safe for the triggers themselves: Postgres checks EXECUTE on a trigger
-- function when the trigger is created, never when it fires.
--
-- Covers every trigger function in "public" at the time it runs, so it needs no
-- list. A trigger function added later must revoke for itself (as vibe_tags_guard
-- did); tests/db-security.sql rule 8 and tests/database.mjs fail if one doesn't.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
