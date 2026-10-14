-- Minimal stand-in for the parts of Supabase the migrations rely on, so the schema and
-- its security rules can be tested on plain PostgreSQL (locally and in CI).
-- NEVER run this against a real Supabase project.
-- Roles are server-wide, so only create them if a previous run has not.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  email_confirmed_at  timestamptz,
  raw_user_meta_data  jsonb default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);

-- Supabase installs extensions in their own schema. pgcrypto ships with PostgreSQL (contrib).
-- Extensions belong to one database, and scripts/test-db.sh creates a new one each run.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Supabase Vault, reduced to what the migrations use, with the same names and signatures. The real
-- Vault encrypts each secret with a key kept outside the database; this stand-in keeps them in plain
-- text, which is acceptable only in a throwaway test database. The API roles get no access, as on
-- Supabase.
create schema vault;
revoke all on schema vault from public;
create table vault.secrets (
  id           uuid primary key default gen_random_uuid(),
  name         text unique,
  description  text not null default '',
  secret       text not null,
  key_id       uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select s.id, s.name, s.description, s.secret, s.secret as decrypted_secret, s.key_id, s.created_at, s.updated_at
  from vault.secrets s;
create function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
) returns uuid language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, new_description, new_key_id)
  returning id
$$;
revoke execute on function vault.create_secret(text, text, text, uuid) from public;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants table access to these roles by default and relies on RLS.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
