-- M1 tests: staff invites and enrollment RPCs, the new verification columns and the rider-flow
-- RPCs. Run by scripts/test-db.sh after 10_rls_test.sql in the same database; the ids used here
-- do not overlap with that file's fixtures. Any failed assertion aborts with an error.
\set ON_ERROR_STOP on

create function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'ok: %', label;
end $$;

create function pg_temp.assert_text(actual text, expected text, label text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'ok: %', label;
end $$;

create function pg_temp.assert_true(condition boolean, label text) returns void
language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'ok: %', label;
end $$;

-- What the admin Edge Function sends: sha256 hex of the normalised invite code.
create function pg_temp.code_hash(code text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(code, 'UTF8')), 'hex')
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.code_hash(text) to anon, authenticated, service_role;

-- Enrollment is explicit: nothing reacts to Auth writing auth.users (foreign keys add internal triggers only).
select pg_temp.assert_eq((select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal), 0,
  'there is no trigger on auth.users');

-- Staff fixtures (as superuser) ----------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('b1000000-0000-0000-0000-000000000001', 'admin@m1.test', now()),
  ('b1000000-0000-0000-0000-000000000002', 'supervisor@m1.test', now()),
  ('b1000000-0000-0000-0000-000000000003', 'reviewer@m1.test', now()),
  ('b1000000-0000-0000-0000-000000000004', 'former-admin@m1.test', now()),
  ('b1000000-0000-0000-0000-000000000005', 'not-staff@m1.test', now());
insert into public.staff_profile (user_id, role, full_name, active) values
  ('b1000000-0000-0000-0000-000000000001', 'admin', 'M1 Admin', true),
  ('b1000000-0000-0000-0000-000000000002', 'supervisor', 'M1 Supervisor', true),
  ('b1000000-0000-0000-0000-000000000003', 'reviewer', 'M1 Reviewer', true),
  ('b1000000-0000-0000-0000-000000000004', 'admin', 'M1 Former Admin', false);

-- Auth users that already exist when their owner enrolls.
insert into auth.users (id, email, email_confirmed_at) values
  ('b2000000-0000-0000-0000-000000000002', 'existing@m1.test', now()),
  ('b2000000-0000-0000-0000-000000000003', 'Mixed.Case@M1.Test', now()),
  ('b2000000-0000-0000-0000-000000000004', 'unconfirmed@m1.test', null),
  ('b2000000-0000-0000-0000-000000000005', 'stranger@m1.test', now()),
  ('b2000000-0000-0000-0000-000000000006', 'used@m1.test', now()),
  ('b2000000-0000-0000-0000-000000000007', null, now()),
  ('b2000000-0000-0000-0000-000000000008', 'expired@m1.test', now()),
  ('b2000000-0000-0000-0000-000000000009', 'lock@m1.test', now());
-- A deactivated reviewer who is now invited as admin: the invite must not promote or reactivate them.
insert into public.staff_profile (user_id, role, full_name, active)
  values ('b2000000-0000-0000-0000-000000000002', 'reviewer', 'Existing Person', false);

insert into public.staff_invite (email, role, full_name, code_hash, expires_at, invited_by, accepted_at, accepted_user_id) values
  ('open@m1.test',         'supervisor', 'Open Invite',       pg_temp.code_hash('OPEN0001'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('lock@m1.test',         'supervisor', 'Locked Invite',     pg_temp.code_hash('LOCK0001'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('edge@m1.test',         'reviewer',   'Four Misses',       pg_temp.code_hash('EDGE0001'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('expired@m1.test',      'reviewer',   'Expired Invite',    pg_temp.code_hash('EXPIRED1'),   now() - interval '1 minute', 'b1000000-0000-0000-0000-000000000001', null, null),
  ('used@m1.test',         'reviewer',   'Used Invite',       pg_temp.code_hash('USED0001'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', now(), 'b2000000-0000-0000-0000-000000000006'),
  ('new.reviewer@m1.test', 'reviewer',   'New Reviewer',      pg_temp.code_hash('NEWREV01'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('existing@m1.test',     'admin',      'Invite For Existing', pg_temp.code_hash('EXIST001'), now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('mixed.case@m1.test',   'supervisor', 'Mixed Case',        pg_temp.code_hash('MIXED001'),   now() + interval '1 day',    'b1000000-0000-0000-0000-000000000001', null, null),
  ('mismatch@m1.test',     'admin',      'Not For Stranger',  pg_temp.code_hash('MISMATCH'),   now() + interval '1 day',    null, null, null);

-- staff_invite constraints -----------------------------------------------------------------------
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('Upper@m1.test', 'reviewer', 'X', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: mixed-case invite email was stored';
exception when check_violation then raise notice 'ok: invite emails must be lower-case';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values (' spaced@m1.test', 'reviewer', 'X', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: invite email with a space was stored';
exception when check_violation then raise notice 'ok: invite emails cannot contain spaces';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('not-an-email', 'reviewer', 'X', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: invite without an @ was stored';
exception when check_violation then raise notice 'ok: invite emails need an @';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('open@m1.test', 'reviewer', 'X', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: a second invite for the same email was stored';
exception when unique_violation then raise notice 'ok: one invite per email';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('rawcode@m1.test', 'reviewer', 'X', 'OPEN0001', now() + interval '1 day');
  raise exception 'FAIL: a plain-text code was stored as code_hash';
exception when check_violation then raise notice 'ok: code_hash must be a sha256 hex digest, never the code';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('upperhash@m1.test', 'reviewer', 'X', upper(pg_temp.code_hash('X')), now() + interval '1 day');
  raise exception 'FAIL: an upper-case code_hash was stored';
exception when check_violation then raise notice 'ok: code_hash is stored as lower-case hex';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash) values ('noexpiry@m1.test', 'reviewer', 'X', pg_temp.code_hash('X'));
  raise exception 'FAIL: invite without an expiry was stored';
exception when not_null_violation then raise notice 'ok: invites need an expiry';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('nameless@m1.test', 'reviewer', null, pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: invite without a name was stored';
exception when not_null_violation then raise notice 'ok: invites need a full name';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('roleless@m1.test', null, 'X', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: invite without a role was stored';
exception when not_null_violation then raise notice 'ok: invites need a role';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash) values ('nohash@m1.test', 'reviewer', 'X', null);
  raise exception 'FAIL: invite without a code hash was stored';
exception when not_null_violation then raise notice 'ok: invites need a code hash';
end $$;
do $$ begin
  update public.staff_invite set failed_attempts = -1 where email = 'open@m1.test';
  raise exception 'FAIL: negative failed_attempts was stored';
exception when check_violation then raise notice 'ok: failed_attempts cannot be negative';
end $$;
do $$ begin
  update public.staff_invite set accepted_user_id = 'b2000000-0000-0000-0000-000000000005' where email = 'open@m1.test';
  raise exception 'FAIL: an accepting user was stored on an unaccepted invite';
exception when check_violation then raise notice 'ok: accepted_user_id requires accepted_at';
end $$;
select pg_temp.assert_eq((select count(*) from public.staff_invite where failed_attempts = 0 and created_at is not null), 9,
  'failed_attempts defaults to 0 and created_at is set');

-- staff_invite RLS: admins read (except the code hash), nobody writes directly -------------------
select pg_temp.assert_true((select relrowsecurity from pg_class where oid = 'public.staff_invite'::regclass),
  'RLS is enabled on staff_invite');

begin;
set local role anon;
do $$ begin
  perform count(*) from public.staff_invite;
  raise exception 'FAIL: anon could read staff invites';
exception when insufficient_privilege then raise notice 'ok: anon cannot read staff invites';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000005';
select pg_temp.assert_eq((select count(*) from public.staff_invite), 0, 'non-staff sees no invites');
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000003';
select pg_temp.assert_eq((select count(*) from public.staff_invite), 0, 'reviewer sees no invites');
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.staff_invite), 0, 'supervisor sees no invites');
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000004';
select pg_temp.assert_eq((select count(*) from public.staff_invite), 0, 'deactivated admin sees no invites');
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.staff_invite), 9, 'admin reads all invites');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email = 'open@m1.test' and role = 'supervisor' and failed_attempts = 0 and accepted_at is null), 1,
  'admin reads invite details');
do $$ begin
  perform code_hash from public.staff_invite;
  raise exception 'FAIL: admin read invite code hashes';
exception when insufficient_privilege then raise notice 'ok: admin cannot read invite code hashes';
end $$;
do $$ begin
  insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
    values ('sneaky@m1.test', 'admin', 'Sneaky', pg_temp.code_hash('X'), now() + interval '1 day');
  raise exception 'FAIL: admin created an invite directly';
exception when insufficient_privilege then raise notice 'ok: admin cannot create invites directly';
end $$;
do $$ begin
  update public.staff_invite set failed_attempts = 0;
  raise exception 'FAIL: admin reset an invite directly';
exception when insufficient_privilege then raise notice 'ok: admin cannot update invites directly';
end $$;
do $$ begin
  delete from public.staff_invite;
  raise exception 'FAIL: admin deleted invites directly';
exception when insufficient_privilege then raise notice 'ok: admin cannot delete invites directly';
end $$;
rollback;

-- staff_invite_verify ----------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_invite_verify('open@m1.test', pg_temp.code_hash('OPEN0001')),
  'ok', 'verify: right code for an open invite returns ok');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email = 'open@m1.test' and failed_attempts = 0 and accepted_at is null and accepted_user_id is null), 1,
  'verify: ok counts no attempt and does not consume the invite');
select pg_temp.assert_text(public.staff_invite_verify('Open@M1.Test', pg_temp.code_hash('OPEN0001')),
  'ok', 'verify: the email is matched case-insensitively');
select pg_temp.assert_text(public.staff_invite_verify('open@m1.test', upper(pg_temp.code_hash('OPEN0001'))),
  'ok', 'verify: an upper-case hex digest is accepted');
select pg_temp.assert_text(public.staff_invite_verify('open@m1.test', pg_temp.code_hash('WRONG001')),
  'invalid', 'verify: a wrong code returns invalid');
select pg_temp.assert_eq((select failed_attempts from public.staff_invite where email = 'open@m1.test'), 1,
  'verify: a wrong code counts one attempt');
select pg_temp.assert_text(public.staff_invite_verify('OPEN@m1.test', null),
  'invalid', 'verify: a missing code returns invalid');
select pg_temp.assert_eq((select failed_attempts from public.staff_invite where email = 'open@m1.test'), 2,
  'verify: a missing code counts as a wrong code');
select pg_temp.assert_text(public.staff_invite_verify('open@m1.test', pg_temp.code_hash('OPEN0001')),
  'ok', 'verify: the right code still works below the limit');

-- Four misses leave one try; the fifth miss locks the invite.
select pg_temp.assert_eq((select count(*) from generate_series(1, 4)
  where public.staff_invite_verify('edge@m1.test', pg_temp.code_hash('MISS' || generate_series)) = 'invalid'), 4,
  'verify: four wrong codes return invalid');
select pg_temp.assert_text(public.staff_invite_verify('edge@m1.test', pg_temp.code_hash('EDGE0001')),
  'ok', 'verify: the right code after 4 failures returns ok');

select pg_temp.assert_eq((select count(*) from generate_series(1, 5)
  where public.staff_invite_verify('lock@m1.test', pg_temp.code_hash('MISS' || generate_series)) = 'invalid'), 5,
  'verify: five wrong codes return invalid');
select pg_temp.assert_eq((select failed_attempts from public.staff_invite where email = 'lock@m1.test'), 5,
  'verify: five wrong codes are counted');
select pg_temp.assert_text(public.staff_invite_verify('lock@m1.test', pg_temp.code_hash('LOCK0001')),
  'invalid', 'verify: after 5 failures even the right code returns invalid (locked)');
select pg_temp.assert_text(public.staff_invite_verify('lock@m1.test', pg_temp.code_hash('MISS6')),
  'invalid', 'verify: a locked invite returns invalid for a wrong code');
select pg_temp.assert_eq((select failed_attempts from public.staff_invite where email = 'lock@m1.test'), 5,
  'verify: a locked invite counts no further attempts');

-- Every counted wrong code leaves an audit trace; the fifth one says the invite is now locked.
-- So far: open@ 2, edge@ 4, lock@ 5 (the last one locking it).
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'staff_invite.failed_attempt' and actor_type = 'system' and target_type = 'staff_invite'), 10,
  'verify: each counted wrong code writes a staff_invite.failed_attempt audit event');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'staff_invite.locked' and (details ->> 'failedAttempts')::int = 5), 1,
  'verify: the fifth wrong code writes staff_invite.locked');
select pg_temp.assert_eq((select count(*) from public.audit_event ae
  where ae.action like 'staff_invite.%'
    and (row_to_json(ae)::text ilike '%@m1.test%' or row_to_json(ae)::text ilike '%MISS%'
         or ae.target_id is not null or ae.actor_id is not null)), 0,
  'verify: invite audit events hold neither the address nor the code');

select pg_temp.assert_text(public.staff_invite_verify('expired@m1.test', pg_temp.code_hash('EXPIRED1')),
  'invalid', 'verify: an expired invite returns invalid');
select pg_temp.assert_text(public.staff_invite_verify('used@m1.test', pg_temp.code_hash('USED0001')),
  'invalid', 'verify: an accepted invite returns invalid');
select pg_temp.assert_text(public.staff_invite_verify('nobody@m1.test', pg_temp.code_hash('OPEN0001')),
  'invalid', 'verify: an unknown email returns invalid');
select pg_temp.assert_text(public.staff_invite_verify(null, pg_temp.code_hash('OPEN0001')),
  'invalid', 'verify: a missing email returns invalid');
select pg_temp.assert_text(public.staff_invite_verify('expired@m1.test', pg_temp.code_hash('WRONG001')),
  'invalid', 'verify: a wrong code for an expired invite returns invalid');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email in ('expired@m1.test', 'used@m1.test') and failed_attempts = 0), 2,
  'verify: closed invites (expired, used) count no attempts');
-- One answer for every cause, so the endpoint cannot be used to probe addresses or invite states.
select pg_temp.assert_true((select array_agg(distinct outcome) = array['invalid'] from (values
    (public.staff_invite_verify('nobody@m1.test', pg_temp.code_hash('OPEN0001'))),
    (public.staff_invite_verify('expired@m1.test', pg_temp.code_hash('EXPIRED1'))),
    (public.staff_invite_verify('used@m1.test', pg_temp.code_hash('USED0001'))),
    (public.staff_invite_verify('lock@m1.test', pg_temp.code_hash('LOCK0001'))),
    (public.staff_invite_verify('mixed.case@m1.test', pg_temp.code_hash('WRONG001')))
  ) as t(outcome)),
  'verify: unknown, expired, used, locked and wrong-code all return the same ''invalid''');
commit;

-- staff_find_auth_user -----------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.staff_find_auth_user('mixed.case@m1.test')
  where user_id = 'b2000000-0000-0000-0000-000000000003' and email_confirmed), 1,
  'find: a confirmed user is found case-insensitively');
select pg_temp.assert_eq((select count(*) from public.staff_find_auth_user('UNCONFIRMED@m1.test')
  where user_id = 'b2000000-0000-0000-0000-000000000004' and not email_confirmed), 1,
  'find: an unconfirmed user is reported as unconfirmed');
select pg_temp.assert_eq((select count(*) from public.staff_find_auth_user('new.reviewer@m1.test')), 0,
  'find: no row when no auth user has the address');
select pg_temp.assert_eq((select count(*) from public.staff_find_auth_user(null)), 0,
  'find: no row for a missing email (users without an email are never matched)');
rollback;

-- staff_invite_accept --------------------------------------------------------------------------------
-- Enroll found no user for new.reviewer@m1.test, so it creates a confirmed one (as Auth would).
insert into auth.users (id, email, email_confirmed_at)
  values ('b2000000-0000-0000-0000-000000000001', 'new.reviewer@m1.test', now());

begin;
set local role service_role;
select pg_temp.assert_text(public.staff_invite_accept('new.reviewer@m1.test', pg_temp.code_hash('WRONG001'), 'b2000000-0000-0000-0000-000000000001'),
  'invalid', 'accept: a wrong code returns invalid');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email = 'new.reviewer@m1.test' and failed_attempts = 0 and accepted_at is null), 1,
  'accept: a wrong code counts no attempt and leaves the invite open');
select pg_temp.assert_text(public.staff_invite_accept('new.reviewer@m1.test', pg_temp.code_hash('NEWREV01'), 'b2000000-0000-0000-0000-000000000001'),
  'ok', 'accept: right code returns ok');
select pg_temp.assert_eq((select count(*) from public.staff_profile
  where user_id = 'b2000000-0000-0000-0000-000000000001' and role = 'reviewer' and full_name = 'New Reviewer' and active), 1,
  'accept: creates an active staff profile with the invite''s role and name');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email = 'new.reviewer@m1.test' and accepted_at is not null and accepted_user_id = 'b2000000-0000-0000-0000-000000000001'), 1,
  'accept: marks the invite accepted by that user');
select pg_temp.assert_text(public.staff_invite_accept('new.reviewer@m1.test', pg_temp.code_hash('NEWREV01'), 'b2000000-0000-0000-0000-000000000001'),
  'invalid', 'accept: a second call returns invalid (single use)');
select pg_temp.assert_text(public.staff_invite_verify('new.reviewer@m1.test', pg_temp.code_hash('NEWREV01')),
  'invalid', 'verify: an invite accepted through accept is no longer valid');
select pg_temp.assert_eq((select count(*) from public.staff_profile where user_id = 'b2000000-0000-0000-0000-000000000001'), 1,
  'accept: a second call creates no extra profile');

select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'staff.enroll' and actor_type = 'staff' and actor_id = 'b2000000-0000-0000-0000-000000000001'
    and target_type = 'staff_profile' and target_id = 'b2000000-0000-0000-0000-000000000001'
    and details ->> 'role' = 'reviewer' and details ->> 'profileCreated' = 'true'), 1,
  'accept: writes one staff.enroll audit event with the role');
select pg_temp.assert_true((select array_agg(k order by k) = array['profileCreated', 'role']
    from public.audit_event ae, jsonb_object_keys(ae.details) as k
    where ae.action = 'staff.enroll' and ae.target_id = 'b2000000-0000-0000-0000-000000000001'),
  'accept: audit details hold only the role and whether a profile was created');
select pg_temp.assert_eq((select count(*) from public.audit_event ae
  where ae.action = 'staff.enroll'
    and (row_to_json(ae)::text ilike '%NEWREV01%' or row_to_json(ae)::text ilike '%' || pg_temp.code_hash('NEWREV01') || '%')), 0,
  'accept: the audit row contains neither the code nor its hash');

-- An existing profile is kept as it is (no promotion, no reactivation), but the invite is used up.
select pg_temp.assert_text(public.staff_invite_accept('existing@m1.test', pg_temp.code_hash('EXIST001'), 'b2000000-0000-0000-0000-000000000002'),
  'ok', 'accept: ok for a user who already has a staff profile');
select pg_temp.assert_eq((select count(*) from public.staff_profile
  where user_id = 'b2000000-0000-0000-0000-000000000002' and role = 'reviewer' and full_name = 'Existing Person' and not active), 1,
  'accept: an existing staff profile is not overwritten');
select pg_temp.assert_eq((select count(*) from public.staff_invite
  where email = 'existing@m1.test' and accepted_user_id = 'b2000000-0000-0000-0000-000000000002'), 1,
  'accept: the invite is consumed even when the profile already existed');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'staff.enroll' and target_id = 'b2000000-0000-0000-0000-000000000002'
    and details ->> 'role' = 'admin' and details ->> 'profileCreated' = 'false'), 1,
  'accept: the audit event records that the existing profile was kept');

select pg_temp.assert_text(public.staff_invite_accept('Mixed.Case@M1.Test', pg_temp.code_hash('MIXED001'), 'b2000000-0000-0000-0000-000000000003'),
  'ok', 'accept: the email is matched case-insensitively (invite and auth user)');

-- Failures: same 'invalid', nothing written. Each closed invite is tried with its own address's
-- account, so it is the invite state (not the account check) that refuses it.
select pg_temp.assert_text(public.staff_invite_accept('mismatch@m1.test', pg_temp.code_hash('MISMATCH'), 'b2000000-0000-0000-0000-000000000005'),
  'invalid', 'accept: the invite cannot be bound to an account with another email');
select pg_temp.assert_text(public.staff_invite_accept('mismatch@m1.test', pg_temp.code_hash('MISMATCH'), 'b2000000-0000-0000-0000-0000000000ff'),
  'invalid', 'accept: an unknown user id returns invalid');
select pg_temp.assert_text(public.staff_invite_accept('mismatch@m1.test', pg_temp.code_hash('MISMATCH'), null),
  'invalid', 'accept: a missing user id returns invalid');
select pg_temp.assert_eq((select count(*) from public.staff_invite where email = 'mismatch@m1.test' and accepted_at is null), 1,
  'accept: a refused user leaves the invite open');
select pg_temp.assert_text(public.staff_invite_accept('expired@m1.test', pg_temp.code_hash('EXPIRED1'), 'b2000000-0000-0000-0000-000000000008'),
  'invalid', 'accept: an expired invite returns invalid');
select pg_temp.assert_text(public.staff_invite_accept('lock@m1.test', pg_temp.code_hash('LOCK0001'), 'b2000000-0000-0000-0000-000000000009'),
  'invalid', 'accept: a locked invite returns invalid');
select pg_temp.assert_text(public.staff_invite_accept('used@m1.test', pg_temp.code_hash('USED0001'), 'b2000000-0000-0000-0000-000000000006'),
  'invalid', 'accept: an invite accepted earlier returns invalid');
select pg_temp.assert_text(public.staff_invite_accept('nobody@m1.test', pg_temp.code_hash('OPEN0001'), 'b2000000-0000-0000-0000-000000000005'),
  'invalid', 'accept: an unknown email returns invalid');
select pg_temp.assert_eq((select count(*) from public.staff_profile
  where user_id in ('b2000000-0000-0000-0000-000000000005', 'b2000000-0000-0000-0000-000000000006',
                    'b2000000-0000-0000-0000-000000000008', 'b2000000-0000-0000-0000-000000000009')), 0,
  'accept: refused calls create no staff profile');
select pg_temp.assert_eq((select failed_attempts from public.staff_invite where email = 'mismatch@m1.test'), 0,
  'accept: refused calls count no attempts');
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'staff.enroll'), 3,
  'accept: only successful calls are audited');
commit;

-- Inviting someone again (forgotten password, locked or expired invite): the documented upsert
-- (migration comment) reopens the address's row with a new code. Redeeming it binds the same
-- account again and keeps its profile.
begin;
insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
values ('new.reviewer@m1.test', 'supervisor', 'Renamed', pg_temp.code_hash('AGAIN001'), now() + interval '7 days')
on conflict (email) do update
  set role = excluded.role, full_name = excluded.full_name, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, failed_attempts = 0, accepted_at = null, accepted_user_id = null;
insert into public.staff_invite (email, role, full_name, code_hash, expires_at)
values ('lock@m1.test', 'supervisor', 'Locked Invite', pg_temp.code_hash('UNLOCK01'), now() + interval '7 days')
on conflict (email) do update
  set role = excluded.role, full_name = excluded.full_name, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, failed_attempts = 0, accepted_at = null, accepted_user_id = null;
set local role service_role;
select pg_temp.assert_text(public.staff_invite_verify('new.reviewer@m1.test', pg_temp.code_hash('NEWREV01')),
  'invalid', 're-invite: the old code no longer works');
select pg_temp.assert_text(public.staff_invite_verify('new.reviewer@m1.test', pg_temp.code_hash('AGAIN001')),
  'ok', 're-invite: the new code works for an address that had already enrolled');
select pg_temp.assert_text(public.staff_invite_accept('new.reviewer@m1.test', pg_temp.code_hash('AGAIN001'), 'b2000000-0000-0000-0000-000000000001'),
  'ok', 're-invite: the same account redeems it again');
select pg_temp.assert_eq((select count(*) from public.staff_profile
  where user_id = 'b2000000-0000-0000-0000-000000000001' and role = 'reviewer' and full_name = 'New Reviewer'), 1,
  're-invite: the existing staff profile is kept as it was');
select pg_temp.assert_text(public.staff_invite_verify('lock@m1.test', pg_temp.code_hash('UNLOCK01')),
  'ok', 're-invite: a locked invite reopened with a new code works again');
rollback;

select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after enrollments');

-- Enrollment RPC privileges: service role only ----------------------------------------------------
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('staff_invite_verify', 'staff_invite_accept', 'staff_find_auth_user')
    and p.prosecdef and p.proconfig = array['search_path=""']), 3,
  'enrollment RPCs are SECURITY DEFINER with an empty search_path');
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.staff_invite_verify(text, text)', 'execute')
  and has_function_privilege('service_role', 'public.staff_invite_accept(text, text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.staff_find_auth_user(text)', 'execute'),
  'service role can execute the enrollment RPCs');
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.staff_invite_verify(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_invite_accept(text, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.staff_find_auth_user(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_invite_verify(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_invite_accept(text, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_find_auth_user(text)', 'execute'),
  'anon and authenticated have no execute right on the enrollment RPCs');

begin;
set local role anon;
do $$ begin
  perform public.staff_invite_verify('open@m1.test', pg_temp.code_hash('OPEN0001'));
  raise exception 'FAIL: anon called staff_invite_verify';
exception when insufficient_privilege then raise notice 'ok: anon cannot call staff_invite_verify';
end $$;
do $$ begin
  perform public.staff_invite_accept('mismatch@m1.test', pg_temp.code_hash('MISMATCH'), 'b2000000-0000-0000-0000-000000000005');
  raise exception 'FAIL: anon called staff_invite_accept';
exception when insufficient_privilege then raise notice 'ok: anon cannot call staff_invite_accept';
end $$;
do $$ begin
  perform * from public.staff_find_auth_user('stranger@m1.test');
  raise exception 'FAIL: anon called staff_find_auth_user';
exception when insufficient_privilege then raise notice 'ok: anon cannot call staff_find_auth_user';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000001';
do $$ begin
  perform public.staff_invite_verify('open@m1.test', pg_temp.code_hash('OPEN0001'));
  raise exception 'FAIL: authenticated user called staff_invite_verify';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even admin) cannot call staff_invite_verify';
end $$;
do $$ begin
  perform public.staff_invite_accept('mismatch@m1.test', pg_temp.code_hash('MISMATCH'), 'b2000000-0000-0000-0000-000000000005');
  raise exception 'FAIL: authenticated user called staff_invite_accept';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even admin) cannot call staff_invite_accept';
end $$;
do $$ begin
  perform * from public.staff_find_auth_user('stranger@m1.test');
  raise exception 'FAIL: authenticated user called staff_find_auth_user';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even admin) cannot call staff_find_auth_user';
end $$;
rollback;

-- New verification columns -------------------------------------------------------------------------
insert into public.api_client (id, name, api_key_hash) values ('c1000000-0000-0000-0000-000000000001', 'm1-test-client', 'disabled:m1');
insert into public.applicant (id, api_client_id, external_user_id)
  values ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'm1-rider-1');

begin;
insert into public.verification (id, applicant_id, attempt_no)
  values ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 1);
select pg_temp.assert_eq((select count(*) from public.verification
  where id = 'c3000000-0000-0000-0000-000000000001' and declared_document is null and not is_test and upload_url_count = 0), 1,
  'new verification columns default to no document, not a test, zero upload links');
insert into public.verification (applicant_id, attempt_no, declared_document, is_test)
  select 'c2000000-0000-0000-0000-000000000001', 100 + n, d, true
  from unnest(array['cni_biometric', 'cni_legacy', 'passport', 'residence_permit', 'driving_licence', 'voter_card'])
    with ordinality as t(d, n);
select pg_temp.assert_eq((select count(*) from public.verification
  where applicant_id = 'c2000000-0000-0000-0000-000000000001' and is_test), 6, 'all six declared documents are accepted');
do $$ begin
  insert into public.verification (applicant_id, attempt_no, declared_document)
    values ('c2000000-0000-0000-0000-000000000001', 2, 'cni');
  raise exception 'FAIL: unknown declared document was stored';
exception when check_violation then raise notice 'ok: declared_document only accepts the six documents (the M1 ''cni'' is gone)';
end $$;
do $$ begin
  insert into public.verification (applicant_id, attempt_no, declared_document)
    values ('c2000000-0000-0000-0000-000000000001', 2, 'CNI');
  raise exception 'FAIL: upper-case declared document was stored';
exception when check_violation then raise notice 'ok: declared_document values are exact (lower-case)';
end $$;
do $$ begin
  insert into public.verification (applicant_id, attempt_no, is_test)
    values ('c2000000-0000-0000-0000-000000000001', 2, null);
  raise exception 'FAIL: null is_test was stored';
exception when not_null_violation then raise notice 'ok: is_test is required';
end $$;
do $$ begin
  insert into public.verification (applicant_id, attempt_no, upload_url_count)
    values ('c2000000-0000-0000-0000-000000000001', 2, null);
  raise exception 'FAIL: null upload_url_count was stored';
exception when not_null_violation then raise notice 'ok: upload_url_count is required';
end $$;
do $$ begin
  update public.verification set upload_url_count = -1 where id = 'c3000000-0000-0000-0000-000000000001';
  raise exception 'FAIL: negative upload_url_count was stored';
exception when check_violation then raise notice 'ok: upload_url_count cannot be negative';
end $$;
rollback;

-- flow_claim_upload_slot -------------------------------------------------------------------------------
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, upload_url_count) values
  ('c3000000-0000-0000-0000-000000000010', 'c2000000-0000-0000-0000-000000000001', 10, 'in_progress', 'cni_legacy', 0),
  ('c3000000-0000-0000-0000-000000000011', 'c2000000-0000-0000-0000-000000000001', 11, 'in_progress', 'cni_legacy', 19);

begin;
set local role service_role;
select pg_temp.assert_true(public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', 2), 'upload slot 1 of 2 is granted');
select pg_temp.assert_true(public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', 2), 'upload slot 2 of 2 is granted');
select pg_temp.assert_true(not public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', 2), 'upload slot 3 of 2 is refused');
select pg_temp.assert_eq((select upload_url_count from public.verification where id = 'c3000000-0000-0000-0000-000000000010'), 2,
  'a refused claim does not increment the counter');
select pg_temp.assert_true(public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000011', 20), 'the 20th upload link is granted');
select pg_temp.assert_true(not public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000011', 20), 'the 21st upload link is refused');
select pg_temp.assert_eq((select upload_url_count from public.verification where id = 'c3000000-0000-0000-0000-000000000011'), 20,
  'the counter stops at the limit');
select pg_temp.assert_true(not public.flow_claim_upload_slot('c3000000-0000-0000-0000-0000000000ff', 20), 'unknown verification gets no slot');
select pg_temp.assert_true(not public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', null), 'a null limit grants nothing');
commit;

-- flow_submit ------------------------------------------------------------------------------------------
insert into public.verification (id, applicant_id, attempt_no, status, declared_document) values
  ('c3000000-0000-0000-0000-000000000020', 'c2000000-0000-0000-0000-000000000001', 20, 'in_progress', 'cni_legacy'),
  ('c3000000-0000-0000-0000-000000000021', 'c2000000-0000-0000-0000-000000000001', 21, 'created', 'passport'),
  ('c3000000-0000-0000-0000-000000000022', 'c2000000-0000-0000-0000-000000000001', 22, 'in_progress', 'cni_legacy'),
  ('c3000000-0000-0000-0000-000000000023', 'c2000000-0000-0000-0000-000000000001', 23, 'in_progress', 'cni_legacy');
insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size, deleted_at) values
  ('c3000000-0000-0000-0000-000000000020', 'document_front', 'm1/20/front.jpg', 'm1-20-front', 'image/jpeg', 20000, null),
  ('c3000000-0000-0000-0000-000000000020', 'document_back', 'm1/20/back-erased.jpg', 'm1-20-back-erased', 'image/jpeg', 20000, now()),
  ('c3000000-0000-0000-0000-000000000021', 'document_front', 'm1/21/front.jpg', 'm1-21-front', 'image/jpeg', 20000, null),
  ('c3000000-0000-0000-0000-000000000022', 'document_front', 'm1/22/front.jpg', 'm1-22-front', 'image/jpeg', 20000, null),
  ('c3000000-0000-0000-0000-000000000022', 'document_back', 'm1/22/back.jpg', 'm1-22-back', 'image/jpeg', 20000, null),
  ('c3000000-0000-0000-0000-000000000023', 'document_front', 'm1/23/front.jpg', 'm1-23-front', 'image/jpeg', 20000, null),
  ('c3000000-0000-0000-0000-000000000023', 'document_back', 'm1/23/back.jpg', 'm1-23-back', 'image/jpeg', 20000, null);
-- Verification 23 already has an open task (e.g. created by hand), so submitting it must fail as a whole.
insert into public.review_task (verification_id, status) values ('c3000000-0000-0000-0000-000000000023', 'open');
insert into public.verification (applicant_id, attempt_no, status, declared_document)
  select 'c2000000-0000-0000-0000-000000000001', 200 + n, s::public.verification_status, 'passport'
  from unnest(array['submitted', 'processing', 'in_review', 'approved', 'rejected', 'expired', 'cancelled'])
    with ordinality as t(s, n);

begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000020', array['document_front', 'document_back']),
  'missing_sides', 'submit without the back side (only an erased copy) returns missing_sides');
select pg_temp.assert_eq((select count(*) from public.verification
  where id = 'c3000000-0000-0000-0000-000000000020' and status = 'in_progress' and submitted_at is null), 1,
  'missing_sides leaves the verification unchanged');
select pg_temp.assert_eq((select count(*) from public.review_task where verification_id = 'c3000000-0000-0000-0000-000000000020'), 0,
  'missing_sides opens no review task');
select pg_temp.assert_eq((select count(*) from public.audit_event where target_id = 'c3000000-0000-0000-0000-000000000020'), 0,
  'missing_sides writes no audit event');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000022', array[]::text[]),
  'missing_sides', 'an empty required list is refused (fail closed)');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000022', null),
  'missing_sides', 'a null required list is refused (fail closed)');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000022', array['document_front', 'selfie']),
  'missing_sides', 'a required kind with no capture is missing');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000022', array['document_front', 'not_a_kind']),
  'missing_sides', 'an unknown kind is missing (no cast error)');
commit;

insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size)
  values ('c3000000-0000-0000-0000-000000000020', 'document_back', 'm1/20/back.jpg', 'm1-20-back', 'image/jpeg', 20000);

begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000020', array['document_front', 'document_back']),
  'ok', 'submit with both sides returns ok');
select pg_temp.assert_eq((select count(*) from public.verification
  where id = 'c3000000-0000-0000-0000-000000000020' and status = 'submitted' and submitted_at is not null), 1,
  'submit sets status submitted and submitted_at');
select pg_temp.assert_eq((select count(*) from public.review_task
  where verification_id = 'c3000000-0000-0000-0000-000000000020' and status = 'open'), 1, 'submit opens one review task');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'verification.submit' and actor_type = 'rider' and actor_id = 'c3000000-0000-0000-0000-000000000020'
    and target_type = 'verification' and target_id = 'c3000000-0000-0000-0000-000000000020'), 1,
  'submit writes one rider audit event');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000020', array['document_front', 'document_back']),
  'already_submitted', 'a second submit returns already_submitted');
select pg_temp.assert_eq((select count(*) from public.review_task where verification_id = 'c3000000-0000-0000-0000-000000000020'), 1,
  'a second submit opens no extra review task');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'verification.submit' and target_id = 'c3000000-0000-0000-0000-000000000020'), 1,
  'a second submit writes no extra audit event');
select pg_temp.assert_text(public.flow_submit('c3000000-0000-0000-0000-000000000021', array['document_front']),
  'ok', 'a verification still in status created can be submitted');
select pg_temp.assert_eq((select count(*) from public.verification
  where attempt_no > 200 and applicant_id = 'c2000000-0000-0000-0000-000000000001'
    and public.flow_submit(id, array['document_front']) = 'already_submitted'), 7,
  'every status after in_progress returns already_submitted (checked before the photos)');
select pg_temp.assert_eq((select count(*) from public.review_task rt join public.verification v on v.id = rt.verification_id
  where v.attempt_no > 200 and v.applicant_id = 'c2000000-0000-0000-0000-000000000001'), 0,
  'already_submitted opens no review task');
do $$ begin
  perform public.flow_submit('c3000000-0000-0000-0000-0000000000ff', array['document_front']);
  raise exception 'FAIL: flow_submit accepted an unknown verification';
exception when no_data_found then raise notice 'ok: flow_submit raises for an unknown verification';
end $$;
do $$ begin
  perform public.flow_submit('c3000000-0000-0000-0000-000000000023', array['document_front', 'document_back']);
  raise exception 'FAIL: submit succeeded although an open review task already existed';
exception when unique_violation then raise notice 'ok: a failing submit raises instead of half-applying';
end $$;
select pg_temp.assert_eq((select count(*) from public.verification
  where id = 'c3000000-0000-0000-0000-000000000023' and status = 'in_progress' and submitted_at is null), 1,
  'a failing submit leaves the status unchanged');
select pg_temp.assert_eq((select count(*) from public.audit_event where target_id = 'c3000000-0000-0000-0000-000000000023'), 0,
  'a failing submit writes no audit event');
commit;

select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after submits');

-- Flow RPC privileges: service role only -------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('flow_claim_upload_slot', 'flow_submit')
    and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
    and not p.prosecdef and p.proconfig = array['search_path=""']), 2,
  'flow RPCs are plpgsql, SECURITY INVOKER, with an empty search_path');
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.flow_claim_upload_slot(uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.flow_submit(uuid, text[])', 'execute'),
  'service role can execute the flow RPCs');
-- Checked on the function itself too: anon has no table rights, so a call would fail anyway.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.flow_claim_upload_slot(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.flow_submit(uuid, text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.flow_claim_upload_slot(uuid, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.flow_submit(uuid, text[])', 'execute'),
  'anon and authenticated have no execute right on the flow RPCs');

begin;
set local role anon;
do $$ begin
  perform public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', 1000);
  raise exception 'FAIL: anon called flow_claim_upload_slot';
exception when insufficient_privilege then raise notice 'ok: anon cannot call flow_claim_upload_slot';
end $$;
do $$ begin
  perform public.flow_submit('c3000000-0000-0000-0000-000000000022', array['document_front']);
  raise exception 'FAIL: anon called flow_submit';
exception when insufficient_privilege then raise notice 'ok: anon cannot call flow_submit';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000001';
do $$ begin
  perform public.flow_claim_upload_slot('c3000000-0000-0000-0000-000000000010', 1000);
  raise exception 'FAIL: authenticated user called flow_claim_upload_slot';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even admin) cannot call flow_claim_upload_slot';
end $$;
do $$ begin
  perform public.flow_submit('c3000000-0000-0000-0000-000000000022', array['document_front']);
  raise exception 'FAIL: authenticated user called flow_submit';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even admin) cannot call flow_submit';
end $$;
rollback;

-- Names the code relies on --------------------------------------------------------------------------
-- supabase-js accepts any string in .select(), .insert(), .eq() and .rpc(), so neither the type
-- checks nor the handler tests (in-memory fakes) would notice a renamed column or RPC parameter:
-- the first sign would be a 500 on a phone. These checks pin the names used by
-- supabase/functions/flow/repo.ts, supabase/functions/admin/repo.ts, supabase/functions/worker/repo.ts,
-- supabase/functions/_shared/db.ts (audit) and the dashboard (apps/dashboard/src/api/services.ts,
-- lib/records.ts). A migration that renames one must update the code and this list together.
select pg_temp.assert_true(
  (select array_agg(p.proname || '(' || array_to_string(p.proargnames, ',') || ')' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('flow_claim_upload_slot', 'flow_submit', 'staff_find_auth_user', 'staff_invite_accept', 'staff_invite_verify',
                        'flow_record_mrz', 'staff_read_document_data',
                        'flow_check_state', 'worker_use_nonce', 'worker_claim', 'worker_image_lookup',
                        'worker_case_snapshot', 'worker_record_result', 'worker_write_case'))
  = array[
    'flow_check_state(p_verification,capture_id,kind,live,created_at,job_status,job_error,ring_failed,quality_verdict,phone_mrz_pass)',
    'flow_claim_upload_slot(p_verification,p_max)',
    'flow_record_mrz(p_verification,p_capture,p_lines,p_format,p_outcome,p_details)',
    'flow_submit(p_verification,p_required)',
    'staff_find_auth_user(p_email,user_id,email_confirmed)',
    'staff_invite_accept(p_email,p_code_hash,p_user_id)',
    'staff_invite_verify(p_email,p_code_hash)',
    -- M3: every source; printed fields come back in `fields`.
    'staff_read_document_data(p_verification,p_actor,p_role,capture_id,source,format,lines,fields,recorded_at)',
    'worker_case_snapshot(p_verification,p_job)',
    'worker_claim(job_id,attempt,capture_id,kind,declared_document,sha256,byte_size,width,height)',
    'worker_image_lookup(p_job,p_attempt,result,capture_id,verification_id,storage_path,byte_size)',
    'worker_record_result(p_kid,p_job,p_attempt,p_fingerprint,p_capture_checks,p_evidence,p_case,p_mrz_lines,p_mrz_format,p_fields)',
    'worker_use_nonce(p_kid,p_nonce,p_expires_at)',
    'worker_write_case(p_verification,p_fingerprint,p_case)'
  ],
  'the RPCs and their parameter and result names are those the repos call');

do $$
declare
  missing text;
begin
  select string_agg(used.t || '.' || used.c, ', ') into missing
  from (values
    ('verification', 'id'), ('verification', 'status'), ('verification', 'locale'),
    ('verification', 'declared_document'), ('verification', 'session_expires_at'), ('verification', 'is_test'),
    ('verification', 'session_token_hash'), ('verification', 'created_at'), ('verification', 'submitted_at'),
    ('verification', 'applicant_id'), ('verification', 'attempt_no'), ('verification', 'upload_url_count'),
    ('consent_record', 'id'), ('consent_record', 'verification_id'), ('consent_record', 'consent_version'),
    ('consent_record', 'language'), ('consent_record', 'user_agent'),
    ('capture', 'id'), ('capture', 'verification_id'), ('capture', 'kind'), ('capture', 'storage_path'),
    ('capture', 'sha256'), ('capture', 'mime_type'), ('capture', 'byte_size'), ('capture', 'width'),
    ('capture', 'height'), ('capture', 'quality'), ('capture', 'created_at'), ('capture', 'deleted_at'),
    ('staff_profile', 'user_id'), ('staff_profile', 'role'), ('staff_profile', 'full_name'), ('staff_profile', 'active'),
    ('api_client', 'id'), ('api_client', 'name'), ('api_client', 'api_key_hash'),
    ('applicant', 'id'), ('applicant', 'api_client_id'), ('applicant', 'external_user_id'), ('applicant', 'subject_type'),
    ('review_task', 'id'), ('review_task', 'verification_id'), ('review_task', 'assigned_to'), ('review_task', 'status'),
    ('audit_event', 'actor_type'), ('audit_event', 'actor_id'), ('audit_event', 'action'),
    ('audit_event', 'target_type'), ('audit_event', 'target_id'), ('audit_event', 'details'),
    -- M2: the MRZ check, read by the dashboard through RLS.
    ('check_result', 'id'), ('check_result', 'verification_id'), ('check_result', 'capture_id'),
    ('check_result', 'check_name'), ('check_result', 'check_version'), ('check_result', 'outcome'),
    ('check_result', 'details'), ('check_result', 'created_at'),
    -- M3: the worker's keys and settings, the photo a capture was replaced by, the job a ring failed for.
    ('check_result', 'score'), ('capture', 'superseded_by'),
    ('worker_key', 'kid'), ('worker_key', 'public_key'), ('worker_key', 'revoked_at'),
    ('worker_settings', 'enabled_for_real_sessions'),
    ('worker_job', 'capture_id'), ('worker_job', 'status'), ('worker_job', 'ring_failed_at')
  ) as used(t, c)
  where not exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'public' and ic.table_name = used.t and ic.column_name = used.c
  );
  if missing is not null then
    raise exception 'FAIL: columns named by the code do not exist: %', missing;
  end if;
  raise notice 'ok: every column the repos and the dashboard name exists';
end $$;
