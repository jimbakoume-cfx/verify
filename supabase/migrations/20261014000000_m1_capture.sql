-- Confiance Verify — M1: ID capture and staff enrollment.
--   * verification: the document the rider says they hold, a test-session flag and an
--     upload-link counter.
--   * staff_invite: who may become staff. An administrator stores only the SHA-256 of a one-time
--     code; the new staff member redeems it through POST /admin/enroll, which calls the enrollment
--     RPCs below. There is deliberately no trigger on auth.users: enrollment is explicit.
--   * RPCs for the steps that must be atomic, called by the Edge Functions with the service role.
--     None of them can be executed by anon or authenticated.

-- ---------------------------------------------------------------------------
-- Verification: rider-declared document, test sessions, upload-link budget
-- ---------------------------------------------------------------------------
-- document_type stays reserved for the classifier result (M3).
alter table public.verification
  add column declared_document text
    check (declared_document in ('cni', 'passport', 'residence_permit', 'driving_licence', 'voter_card')),
  add column is_test boolean not null default false,
  add column upload_url_count integer not null default 0 check (upload_url_count >= 0);

-- ---------------------------------------------------------------------------
-- Staff invites
-- ---------------------------------------------------------------------------
-- Until the user-management UI (M9), an administrator creates invites with SQL. Hash the code on
-- your own machine so it never appears in the SQL editor history, e.g. for code ABCD-2345-EFGH
-- (normalised as the admin function does: trimmed, upper-case, spaces and dashes removed):
--   printf %s 'ABCD2345EFGH' | sha256sum
--   insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
--   values ('name@example.com', 'supervisor', 'Full Name', '<hash>', now() + interval '7 days')
--   on conflict (email) do update
--     set role = excluded.role, full_name = excluded.full_name, code_hash = excluded.code_hash,
--         expires_at = excluded.expires_at, failed_attempts = 0, accepted_at = null, accepted_user_id = null;
-- The same statement invites someone again (forgotten password, invite locked after 5 wrong codes,
-- or expired): the address already has a row, which gets the new code, a new expiry and a reset
-- counter. Redeeming it sets the new password on the existing account and keeps its staff profile.
create table public.staff_invite (
  -- Stored lower-case: the enrollment RPCs look it up by lower(email).
  email             text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  role              public.staff_role not null,
  full_name         text not null,
  code_hash         text not null check (code_hash ~ '^[0-9a-f]{64}$'), -- sha256 hex of the normalised code
  expires_at        timestamptz not null,
  failed_attempts   integer not null default 0 check (failed_attempts >= 0),
  invited_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  accepted_user_id  uuid references auth.users (id) on delete set null,
  check (accepted_user_id is null or accepted_at is not null)
);
create index staff_invite_invited_by_idx on public.staff_invite (invited_by) where invited_by is not null;
create index staff_invite_accepted_user_idx on public.staff_invite (accepted_user_id) where accepted_user_id is not null;

alter table public.staff_invite enable row level security;
-- Writes go through the service role only. Admins may read invites, but not the code hash:
-- a short code could be brute-forced offline from it.
revoke all on public.staff_invite from anon, authenticated;
grant select (email, role, full_name, expires_at, failed_attempts, invited_by, created_at, accepted_at, accepted_user_id)
  on public.staff_invite to authenticated;

create policy "admins read staff invites" on public.staff_invite
  for select to authenticated
  using ((select private.is_staff_at_least('admin')));

-- ---------------------------------------------------------------------------
-- Staff enrollment RPCs (called by the `admin` Edge Function with the service role)
-- SECURITY DEFINER: they read auth.users, on which the API roles have no rights.
-- Every failure is the same 'invalid', so a caller cannot tell an unknown address from an
-- expired, used or locked invite.
-- ---------------------------------------------------------------------------

-- 'ok' when the code matches an open invite. A wrong code for an open invite counts as an
-- attempt; after 5 the invite is locked. Does not consume the invite.
create function public.staff_invite_verify(p_email text, p_code_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.staff_invite;
begin
  -- The row lock queues concurrent guesses, so no more than 5 codes are ever compared.
  select si.* into inv from public.staff_invite si where si.email = lower(p_email) for update;
  if not found or inv.accepted_at is not null or inv.expires_at <= now() or inv.failed_attempts >= 5 then
    return 'invalid';
  end if;
  if inv.code_hash is distinct from lower(p_code_hash) then
    update public.staff_invite si set failed_attempts = si.failed_attempts + 1 where si.email = inv.email;
    -- A guessing attempt, or someone locking the invitee out, must leave a trace. The answer stays
    -- the same 'invalid'; the address and the code stay out of the audit log (admins see which
    -- invite in staff_invite.failed_attempts).
    insert into public.audit_event (actor_type, action, target_type, details)
    values ('system',
            case when inv.failed_attempts + 1 >= 5 then 'staff_invite.locked' else 'staff_invite.failed_attempt' end,
            'staff_invite', jsonb_build_object('failedAttempts', inv.failed_attempts + 1));
    return 'invalid';
  end if;
  return 'ok';
end;
$$;

-- Redeems the invite for an auth user that enroll has just created or updated. Re-checks the
-- invite as verify does (without counting attempts), creates the staff profile and consumes the
-- invite, all in one transaction.
create function public.staff_invite_accept(p_email text, p_code_hash text, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.staff_invite;
  profile_created boolean;
begin
  -- The row lock makes the invite single-use even when two enrollments race.
  select si.* into inv from public.staff_invite si where si.email = lower(p_email) for update;
  if not found or inv.accepted_at is not null or inv.expires_at <= now() or inv.failed_attempts >= 5
     or inv.code_hash is distinct from lower(p_code_hash) then
    return 'invalid';
  end if;
  -- The invite belongs to its address: never bind it to another account.
  if not exists (select 1 from auth.users u where u.id = p_user_id and lower(u.email) = inv.email) then
    return 'invalid';
  end if;

  -- Never overwrite an existing profile: changing a role or reactivating staff is an admin decision.
  insert into public.staff_profile (user_id, role, full_name)
  values (p_user_id, inv.role, inv.full_name)
  on conflict (user_id) do nothing;
  profile_created := found;

  update public.staff_invite si
     set accepted_at = now(), accepted_user_id = p_user_id
   where si.email = inv.email;

  -- The code (and its hash) never goes into the audit log.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('staff', p_user_id::text, 'staff.enroll', 'staff_profile', p_user_id::text,
          jsonb_build_object('role', inv.role, 'profileCreated', profile_created));
  return 'ok';
end;
$$;

-- Lets enroll reuse an auth user that already exists for the address (a stranger's unconfirmed
-- sign-up, or an earlier half-finished enrollment). Supabase keeps password users' emails unique.
create function public.staff_find_auth_user(p_email text)
returns table (user_id uuid, email_confirmed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email_confirmed_at is not null
  from auth.users u
  where lower(u.email) = lower(p_email)
$$;

revoke execute on function public.staff_invite_verify(text, text) from public, anon, authenticated;
revoke execute on function public.staff_invite_accept(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.staff_find_auth_user(text) from public, anon, authenticated;
grant execute on function public.staff_invite_verify(text, text) to service_role;
grant execute on function public.staff_invite_accept(text, text, uuid) to service_role;
grant execute on function public.staff_find_auth_user(text) to service_role;

-- ---------------------------------------------------------------------------
-- Rider-flow RPCs (called by the `flow` Edge Function with the service role)
-- SECURITY INVOKER: the service role already has the table rights these need.
-- ---------------------------------------------------------------------------

-- Takes one upload link from the session's budget; false once p_max links have been issued.
-- A single conditional update, so concurrent requests cannot overshoot the limit.
create function public.flow_claim_upload_slot(p_verification uuid, p_max integer)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.verification v
     set upload_url_count = v.upload_url_count + 1
   where v.id = p_verification and v.upload_url_count < p_max;
  return found;
end;
$$;

-- Submits a verification for review: 'ok', 'already_submitted' or 'missing_sides'.
-- Status change, review task and audit entry are written together or not at all.
create function public.flow_submit(p_verification uuid, p_required text[])
returns text
language plpgsql
set search_path = ''
as $$
declare
  current_status public.verification_status;
begin
  -- The row lock serialises concurrent submits of the same session.
  select v.status into current_status
  from public.verification v
  where v.id = p_verification
  for update;
  if not found then
    -- The caller has already looked the session up, so this is a bug, not a rider error.
    raise exception 'verification % not found', p_verification using errcode = 'no_data_found';
  end if;

  if current_status not in ('created', 'in_progress') then
    return 'already_submitted';
  end if;

  -- Every document needs at least one side, so an empty list is a caller bug: fail closed.
  if coalesce(cardinality(p_required), 0) = 0 or exists (
    select 1
    from unnest(p_required) as required(kind)
    where not exists (
      select 1 from public.capture c
      where c.verification_id = p_verification
        and c.kind::text = required.kind
        and c.deleted_at is null
    )
  ) then
    return 'missing_sides';
  end if;

  update public.verification v
     set status = 'submitted', submitted_at = now()
   where v.id = p_verification;

  -- Phase 1: every verification goes to human review.
  insert into public.review_task (verification_id, status)
  values (p_verification, 'open');

  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id)
  values ('rider', p_verification::text, 'verification.submit', 'verification', p_verification::text);

  return 'ok';
end;
$$;

revoke execute on function public.flow_claim_upload_slot(uuid, integer) from public, anon, authenticated;
revoke execute on function public.flow_submit(uuid, text[]) from public, anon, authenticated;
grant execute on function public.flow_claim_upload_slot(uuid, integer) to service_role;
grant execute on function public.flow_submit(uuid, text[]) to service_role;
