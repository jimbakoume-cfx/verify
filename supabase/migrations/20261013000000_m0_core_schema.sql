-- Confiance Verify — M0 core schema.
--
-- Security model:
--   * Row Level Security (RLS) is enabled on every table. With no matching policy,
--     access is denied.
--   * Riders never talk to the database directly. Edge Functions act for them
--     using the service role, which bypasses RLS and never leaves the server.
--   * Staff (Supabase Auth users with a staff_profile) only get read access through
--     the policies below. Every write goes through audited Edge Functions.
--   * ID images live in a private storage bucket. It has no storage policies, so only
--     the service role can read it; staff get short-lived links from an audited function.
--
-- Tables that belong to later milestones (liveness_challenge, extracted_document_data,
-- appeal, webhook_delivery, deletion_job) are added in those milestones.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.staff_role as enum ('reviewer', 'supervisor', 'admin');
create type public.subject_type as enum ('rider', 'driver');
create type public.applicant_status as enum ('unverified', 'pending', 'verified', 'rejected', 'blocked');
create type public.verification_status as enum (
  'created', 'in_progress', 'submitted', 'processing', 'in_review',
  'approved', 'rejected', 'expired', 'cancelled'
);
create type public.document_type as enum (
  'cni_legacy', 'cni_biometric', 'passport', 'residence_permit',
  'driving_licence', 'voter_card', 'unknown'
);
create type public.capture_kind as enum ('document_front', 'document_back', 'selfie', 'liveness_frame');
create type public.check_outcome as enum ('pass', 'flag', 'fail', 'error', 'skipped');
create type public.decision_outcome as enum ('approve', 'reject', 'review');
create type public.actor_type as enum ('system', 'staff', 'api_client', 'rider');
create type public.review_task_status as enum ('open', 'assigned', 'done', 'cancelled');

-- ---------------------------------------------------------------------------
-- Staff and role helpers
-- ---------------------------------------------------------------------------
create table public.staff_profile (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        public.staff_role not null,
  full_name   text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Role of the signed-in staff member, or null if not active staff.
-- SECURITY DEFINER so that policies can call it without recursive RLS on staff_profile.
create function public.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profile sp
  where sp.user_id = auth.uid() and sp.active
$$;

create function public.is_staff_at_least(minimum public.staff_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_staff_role() >= minimum, false)
$$;

revoke execute on function public.current_staff_role() from public, anon;
revoke execute on function public.is_staff_at_least(public.staff_role) from public, anon;
grant execute on function public.current_staff_role() to authenticated;
grant execute on function public.is_staff_at_least(public.staff_role) to authenticated;

-- ---------------------------------------------------------------------------
-- Integrations (Confiance ride app today; a driver app later)
-- ---------------------------------------------------------------------------
create table public.api_client (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  api_key_hash       text not null unique,          -- sha256 of the key; the key itself is never stored
  webhook_url        text check (webhook_url is null or webhook_url like 'https://%'),
  webhook_secret_id  uuid,                           -- id of the signing secret in Supabase Vault
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table public.applicant (
  id                uuid primary key default gen_random_uuid(),
  api_client_id     uuid not null references public.api_client (id),
  external_user_id  text not null,                   -- the rider's id in the Confiance app
  subject_type      public.subject_type not null default 'rider',
  status            public.applicant_status not null default 'unverified',
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (api_client_id, external_user_id, subject_type)
);

-- ---------------------------------------------------------------------------
-- Decision thresholds (versioned; rows are never edited, a new version is added)
-- ---------------------------------------------------------------------------
create table public.threshold_config (
  version     integer primary key,
  config      jsonb not null,
  note        text,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Verifications
-- ---------------------------------------------------------------------------
create table public.verification (
  id                        uuid primary key default gen_random_uuid(),
  applicant_id              uuid not null references public.applicant (id),
  attempt_no                integer not null check (attempt_no >= 1),
  status                    public.verification_status not null default 'created',
  locale                    text not null default 'fr' check (locale in ('fr', 'en')),
  session_token_hash        text unique,             -- sha256 of the single-use session token
  session_expires_at        timestamptz,
  document_type             public.document_type,
  risk_score                numeric(5, 4) check (risk_score between 0 and 1),
  threshold_config_version  integer references public.threshold_config (version),
  created_at                timestamptz not null default now(),
  submitted_at              timestamptz,
  decided_at                timestamptz,
  unique (applicant_id, attempt_no)
);

create table public.consent_record (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verification (id) on delete cascade,
  consent_version  text not null,                    -- version of the lawyer-approved wording
  language         text not null check (language in ('fr', 'en')),
  accepted_at      timestamptz not null default now(),
  user_agent       text
);

create table public.capture (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verification (id) on delete cascade,
  kind             public.capture_kind not null,
  storage_path     text not null unique,              -- object path in the private id-captures bucket
  sha256           text not null,                     -- detects the same image reused across attempts
  mime_type        text not null check (mime_type in ('image/jpeg', 'image/webp')),
  byte_size        integer not null check (byte_size > 0),
  width            integer,
  height           integer,
  quality          jsonb not null default '{}'::jsonb, -- blur / glare / framing metrics
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz                         -- set when the image is erased by retention
);
create index capture_sha256_idx on public.capture (sha256);

create table public.check_result (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verification (id) on delete cascade,
  check_name       text not null,                     -- e.g. 'mrz', 'ocr', 'face_match'
  check_version    text not null,                     -- code/model version that produced it
  outcome          public.check_outcome not null,
  score            numeric(6, 5),
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index check_result_verification_idx on public.check_result (verification_id);

-- ---------------------------------------------------------------------------
-- Review and decisions
-- ---------------------------------------------------------------------------
create table public.reason_code (
  code      text primary key,
  rider_fr  text not null,                            -- shown to the rider
  rider_en  text not null,
  retryable boolean not null default true,
  active    boolean not null default true
);

create table public.review_task (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verification (id) on delete cascade,
  status           public.review_task_status not null default 'open',
  priority         smallint not null default 100,     -- lower = more urgent
  assigned_to      uuid references auth.users (id),
  assigned_at      timestamptz,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create index review_task_queue_idx on public.review_task (status, priority, created_at);
create unique index review_task_one_open_per_verification
  on public.review_task (verification_id) where status in ('open', 'assigned');

create table public.decision (
  id                        uuid primary key default gen_random_uuid(),
  verification_id           uuid not null references public.verification (id) on delete cascade,
  actor_type                public.actor_type not null check (actor_type in ('system', 'staff')),
  actor_id                  uuid references auth.users (id),
  outcome                   public.decision_outcome not null,
  reason_code               text references public.reason_code (code),
  note                      text,
  threshold_config_version  integer references public.threshold_config (version),
  created_at                timestamptz not null default now(),
  check ((actor_type = 'staff') = (actor_id is not null)),
  check (outcome <> 'reject' or reason_code is not null)
);
create index decision_verification_idx on public.decision (verification_id);

-- ---------------------------------------------------------------------------
-- Audit log: append-only and hash-chained, so any edit or deletion is detectable.
-- ---------------------------------------------------------------------------
create table public.audit_event (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  actor_type   public.actor_type not null,
  actor_id     text,                                   -- staff user id, api_client id, or verification id
  action       text not null,                          -- e.g. 'capture.view', 'decision.create'
  target_type  text,
  target_id    text,
  details      jsonb not null default '{}'::jsonb,
  prev_hash    text not null,
  hash         text not null
);

create function public.audit_event_hash(e public.audit_event)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Epoch seconds (not timestamptz::text) so the hash does not depend on the session time zone.
  select encode(sha256(convert_to(concat_ws('|',
    e.prev_hash, extract(epoch from e.occurred_at)::text, e.actor_type::text, coalesce(e.actor_id, ''),
    e.action, coalesce(e.target_type, ''), coalesce(e.target_id, ''), e.details::text), 'UTF8')), 'hex')
$$;
revoke execute on function public.audit_event_hash(public.audit_event) from public, anon, authenticated;

create function public.audit_event_chain()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_hash text;
begin
  -- Serialise inserts so the chain has no forks.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('public.audit_event'));
  select ae.hash into last_hash from public.audit_event ae order by ae.id desc limit 1;
  new.occurred_at := now();
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.hash := public.audit_event_hash(new);
  return new;
end;
$$;

create trigger audit_event_chain
  before insert on public.audit_event
  for each row execute function public.audit_event_chain();

create function public.audit_event_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_event is append-only';
end;
$$;

create trigger audit_event_no_update_delete
  before update or delete on public.audit_event
  for each row execute function public.audit_event_immutable();

create trigger audit_event_no_truncate
  before truncate on public.audit_event
  for each statement execute function public.audit_event_immutable();

-- Recomputes the chain; returns the id of the first broken row, or null if intact.
create function public.audit_chain_first_break()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.audit_event;
  expected_prev text := repeat('0', 64);
begin
  for r in select * from public.audit_event order by id loop
    if r.prev_hash <> expected_prev or r.hash <> public.audit_event_hash(r) then
      return r.id;
    end if;
    expected_prev := r.hash;
  end loop;
  return null;
end;
$$;
revoke execute on function public.audit_chain_first_break() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Health check used by the web apps to show "Server connected".
-- ---------------------------------------------------------------------------
create function public.health()
returns text
language sql
stable
set search_path = ''
as $$
  select 'ok'::text
$$;
grant execute on function public.health() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.staff_profile    enable row level security;
alter table public.api_client       enable row level security;
alter table public.applicant        enable row level security;
alter table public.threshold_config enable row level security;
alter table public.verification     enable row level security;
alter table public.consent_record   enable row level security;
alter table public.capture          enable row level security;
alter table public.check_result     enable row level security;
alter table public.reason_code      enable row level security;
alter table public.review_task      enable row level security;
alter table public.decision         enable row level security;
alter table public.audit_event      enable row level security;

-- Belt and braces: the anonymous (rider/browser) role gets no table access at all.
revoke all on all tables in schema public from anon;

-- A reviewer can see a verification only while it is assigned to them.
create function public.is_assigned_reviewer(target_verification uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.review_task rt
    where rt.verification_id = target_verification
      and rt.assigned_to = auth.uid()
      and rt.status = 'assigned'
  )
$$;
revoke execute on function public.is_assigned_reviewer(uuid) from public, anon;
grant execute on function public.is_assigned_reviewer(uuid) to authenticated;

create policy "staff read own profile; admins read all" on public.staff_profile
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_at_least('admin')));

create policy "admins read api clients" on public.api_client
  for select to authenticated
  using ((select public.is_staff_at_least('admin')));

create policy "staff read thresholds" on public.threshold_config
  for select to authenticated
  using ((select public.is_staff_at_least('reviewer')));

create policy "staff read reason codes" on public.reason_code
  for select to authenticated
  using ((select public.is_staff_at_least('reviewer')));

create policy "supervisors see all, reviewers see assigned" on public.verification
  for select to authenticated
  using ((select public.is_staff_at_least('supervisor')) or public.is_assigned_reviewer(id));

create policy "supervisors see all, reviewers see assigned" on public.applicant
  for select to authenticated
  using (
    (select public.is_staff_at_least('supervisor'))
    or exists (select 1 from public.verification v where v.applicant_id = applicant.id and public.is_assigned_reviewer(v.id))
  );

create policy "supervisors read consent records" on public.consent_record
  for select to authenticated
  using ((select public.is_staff_at_least('supervisor')));

-- Capture rows are metadata only; image bytes stay in the private bucket.
create policy "supervisors see all, reviewers see assigned" on public.capture
  for select to authenticated
  using ((select public.is_staff_at_least('supervisor')) or public.is_assigned_reviewer(verification_id));

create policy "supervisors see all, reviewers see assigned" on public.check_result
  for select to authenticated
  using ((select public.is_staff_at_least('supervisor')) or public.is_assigned_reviewer(verification_id));

create policy "supervisors see all, reviewers see assigned" on public.decision
  for select to authenticated
  using ((select public.is_staff_at_least('supervisor')) or public.is_assigned_reviewer(verification_id));

-- Every reviewer may see the queue (to pick work), but not the case contents until assigned.
create policy "staff read review queue" on public.review_task
  for select to authenticated
  using ((select public.is_staff_at_least('reviewer')));

create policy "admins read audit log" on public.audit_event
  for select to authenticated
  using ((select public.is_staff_at_least('admin')));

-- ---------------------------------------------------------------------------
-- Private storage for ID images. No storage.objects policies are created on purpose.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('id-captures', 'id-captures', false, 5242880, array['image/jpeg', 'image/webp']);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into public.threshold_config (version, config, note) values (
  1,
  '{
     "phase": "assisted",
     "auto_approve_below": null,
     "auto_reject_above": null,
     "always_review_document_types": ["voter_card", "driving_licence", "unknown"]
   }'::jsonb,
  'Phase 1 (assisted): every verification goes to human review.'
);

insert into public.reason_code (code, rider_fr, rider_en, retryable) values
  ('DOC_UNREADABLE',    'Votre pièce d''identité n''est pas lisible. Reprenez la photo dans un endroit bien éclairé, sans reflet.', 'Your ID could not be read. Retake the photo in good light, without glare.', true),
  ('DOC_UNSUPPORTED',   'Ce type de document n''est pas accepté. Utilisez une CNI, un passeport ou un titre de séjour.', 'This document type is not accepted. Use a national ID card, passport or residence permit.', true),
  ('DOC_EXPIRED',       'Votre pièce d''identité est expirée. Utilisez un document en cours de validité.', 'Your ID has expired. Please use a valid document.', true),
  ('DOC_INVALID',       'Les informations de votre pièce d''identité n''ont pas pu être validées.', 'The information on your ID could not be validated.', true),
  ('DOC_NOT_ORIGINAL',  'Photographiez directement le document original, pas une copie ni un écran.', 'Photograph the original document directly, not a copy or a screen.', true),
  ('FACE_MISMATCH',     'Votre visage ne correspond pas à la photo de la pièce d''identité.', 'Your face does not match the photo on your ID.', true),
  ('LIVENESS_FAILED',   'Le test devant la caméra n''a pas abouti. Réessayez en suivant les instructions.', 'The camera check did not succeed. Please try again and follow the instructions.', true),
  ('UNDERAGE',          'Vous devez avoir au moins 18 ans pour utiliser Confiance.', 'You must be at least 18 to use Confiance.', false),
  ('DUPLICATE_ACCOUNT', 'Cette pièce d''identité est déjà associée à un autre compte. Contactez le support.', 'This ID is already linked to another account. Please contact support.', false),
  ('OTHER',             'Votre vérification n''a pas pu aboutir. Contactez le support Confiance.', 'Your verification could not be completed. Please contact Confiance support.', false);
