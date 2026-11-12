-- The parts of a Supabase project that supabase/schema.sql takes for granted,
-- so the repo's schema and migrations load into a plain Postgres with PostGIS
-- (tests/db/start.mjs). Nothing here is TripVibz's own: roles, the auth schema
-- the policies call (auth.uid(), auth.jwt()), and the extensions schema.
--
-- Deliberately NOT here: the default table grants older Supabase projects gave
-- anon/authenticated/service_role. The schema snapshot carries every grant the
-- live tables have, and a new migration must grant access itself
-- (supabase/migrations/README.md), so a missing grant fails here the way it
-- would on the live site.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'supabase_admin', 'tripvibz_bot'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
  -- PostgREST signs in as authenticator and switches to the role named in each request's token.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'test-authenticator';
  end if;
end $$;
alter role service_role bypassrls;
alter role supabase_admin bypassrls;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to public;
alter database :"DBNAME" set search_path = "$user", public, extensions;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Only the columns the schema, its triggers and the tests touch.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Same definitions Supabase ships: the signed-in person comes from the request's token.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), auth.jwt() ->> 'sub'), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role')
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to public;

-- Installed in public on the live project (comments.path is a public.ltree).
create extension if not exists ltree with schema public;
