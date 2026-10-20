-- Security-rule tests for the core schema. Run by scripts/test-db.sh on plain PostgreSQL
-- after 00_supabase_stub.sql and the migrations. Any failed assertion aborts with an error.
\set ON_ERROR_STOP on

-- Fixtures (as superuser) ----------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'reviewer1@test'),
  ('00000000-0000-0000-0000-00000000000b', 'reviewer2@test'),
  ('00000000-0000-0000-0000-00000000000c', 'supervisor@test'),
  ('00000000-0000-0000-0000-00000000000d', 'admin@test'),
  ('00000000-0000-0000-0000-00000000000e', 'former@test'),
  ('00000000-0000-0000-0000-00000000000f', 'not-staff@test');

insert into public.staff_profile (user_id, role, full_name, active) values
  ('00000000-0000-0000-0000-00000000000a', 'reviewer', 'Reviewer One', true),
  ('00000000-0000-0000-0000-00000000000b', 'reviewer', 'Reviewer Two', true),
  ('00000000-0000-0000-0000-00000000000c', 'supervisor', 'Supervisor', true),
  ('00000000-0000-0000-0000-00000000000d', 'admin', 'Admin', true),
  ('00000000-0000-0000-0000-00000000000e', 'supervisor', 'Former Supervisor', false);

insert into public.api_client (id, name, api_key_hash)
  values ('10000000-0000-0000-0000-000000000001', 'confiance-ride-app', 'hash');
insert into public.applicant (id, api_client_id, external_user_id) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'rider-1'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'rider-2');
insert into public.verification (id, applicant_id, attempt_no, status) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'in_review'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 1, 'in_review');
insert into public.consent_record (verification_id, consent_version, language)
  values ('30000000-0000-0000-0000-000000000001', 'placeholder-v0', 'fr');
insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size) values
  ('30000000-0000-0000-0000-000000000001', 'document_front', 'v1/front.jpg', 'abc', 'image/jpeg', 1000),
  ('30000000-0000-0000-0000-000000000002', 'document_front', 'v2/front.jpg', 'def', 'image/jpeg', 1000);
insert into public.review_task (verification_id, status, assigned_to, assigned_at) values
  ('30000000-0000-0000-0000-000000000001', 'assigned', '00000000-0000-0000-0000-00000000000a', now()),
  ('30000000-0000-0000-0000-000000000002', 'open', null, null);
insert into public.audit_event (actor_type, action) values ('system', 'test.fixture');

create function pg_temp.assert_eq(actual bigint, expected bigint, label text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'ok: %', label;
end $$;
grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated;

-- Anonymous (browser without login) -------------------------------------------
begin;
set local role anon;
select pg_temp.assert_eq((select count(*) from (select public.health()) h where h.health = 'ok'), 1, 'anon can call health()');
do $$ begin
  perform count(*) from public.verification;
  raise exception 'FAIL: anon could read verification';
exception when insufficient_privilege then raise notice 'ok: anon cannot read verification';
end $$;
do $$ begin
  perform private.current_staff_role();
  raise exception 'FAIL: anon could call current_staff_role()';
exception when insufficient_privilege then raise notice 'ok: anon cannot call role helper';
end $$;
rollback;

-- Signed-in user who is not staff -----------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
select pg_temp.assert_eq((select count(*) from public.verification), 0, 'non-staff sees no verifications');
select pg_temp.assert_eq((select count(*) from public.review_task), 0, 'non-staff sees no queue');
select pg_temp.assert_eq((select count(*) from public.staff_profile), 0, 'non-staff sees no staff profiles');
rollback;

-- Reviewer 1: assigned to verification 1 only -------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select pg_temp.assert_eq((select count(*) from public.verification), 1, 'reviewer sees only the assigned verification');
select pg_temp.assert_eq((select count(*) from public.verification where id = '30000000-0000-0000-0000-000000000002'), 0, 'reviewer cannot see unassigned verification');
select pg_temp.assert_eq((select count(*) from public.capture), 1, 'reviewer sees captures of assigned case only');
select pg_temp.assert_eq((select count(*) from public.applicant), 1, 'reviewer sees applicant of assigned case only');
select pg_temp.assert_eq((select count(*) from public.review_task), 2, 'reviewer sees the whole queue (to pick work)');
select pg_temp.assert_eq((select count(*) from public.consent_record), 0, 'reviewer cannot read consent records');
select pg_temp.assert_eq((select count(*) from public.audit_event), 0, 'reviewer cannot read audit log');
select pg_temp.assert_eq((select count(*) from public.api_client), 0, 'reviewer cannot read api clients');
select pg_temp.assert_eq((select count(*) from public.staff_profile), 1, 'reviewer sees only own staff profile');
select pg_temp.assert_eq((select count(*) from public.reason_code), 10, 'reviewer reads reason codes');
select pg_temp.assert_eq((select count(*) from public.threshold_config), 3, 'reviewer reads every threshold version (M8 seeds version 2, automatic approval adds version 3)');
do $$ begin
  insert into public.decision (verification_id, actor_type, actor_id, outcome)
    values ('30000000-0000-0000-0000-000000000001', 'staff', auth.uid(), 'approve');
  raise exception 'FAIL: reviewer wrote a decision directly';
exception when insufficient_privilege then raise notice 'ok: reviewer cannot write decisions directly';
end $$;
do $$ begin
  update public.review_task set assigned_to = auth.uid(), status = 'assigned'
    where verification_id = '30000000-0000-0000-0000-000000000002';
  if found then raise exception 'FAIL: reviewer self-assigned a task directly'; end if;
  raise notice 'ok: reviewer cannot assign tasks directly';
end $$;
do $$ begin
  insert into public.threshold_config (version, config) values (99, '{}');
  raise exception 'FAIL: reviewer changed thresholds';
exception when insufficient_privilege then raise notice 'ok: reviewer cannot change thresholds';
end $$;
rollback;

-- Reviewer 2: nothing assigned -------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.assert_eq((select count(*) from public.verification), 0, 'reviewer with no assignment sees no cases');
select pg_temp.assert_eq((select count(*) from public.capture), 0, 'reviewer with no assignment sees no captures');
rollback;

-- Supervisor ---------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select pg_temp.assert_eq((select count(*) from public.verification), 2, 'supervisor sees all verifications');
select pg_temp.assert_eq((select count(*) from public.consent_record), 1, 'supervisor reads consent records');
select pg_temp.assert_eq((select count(*) from public.audit_event), 0, 'supervisor cannot read audit log');
rollback;

-- Deactivated staff member ---------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select pg_temp.assert_eq((select count(*) from public.verification), 0, 'deactivated staff sees nothing');
rollback;

-- Admin ------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
select pg_temp.assert_eq((select count(*) from public.audit_event), 2, 'admin reads audit log (the fixture''s entry and the automatic-approval version''s)');
select pg_temp.assert_eq((select count(*) from public.staff_profile), 5, 'admin reads all staff profiles');
do $$ begin
  insert into public.audit_event (actor_type, action) values ('staff', 'forged');
  raise exception 'FAIL: admin wrote to the audit log directly';
exception when insufficient_privilege then raise notice 'ok: admin cannot write audit log directly';
end $$;
rollback;

-- Audit log is append-only and tamper-evident ---------------------------------------------
begin;
set local role service_role;
insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('staff', '00000000-0000-0000-0000-00000000000a', 'capture.view', 'capture', 'x', '{"reason":"review"}');
select pg_temp.assert_eq((select count(*) from public.audit_event), 3, 'service role appends audit events');
do $$ begin
  update public.audit_event set action = 'edited';
  raise exception 'FAIL: audit event was updated';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: audit events cannot be updated (even by service role)';
end $$;
do $$ begin
  delete from public.audit_event;
  raise exception 'FAIL: audit event was deleted';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: audit events cannot be deleted (even by service role)';
end $$;
commit;

select pg_temp.assert_eq(public.audit_chain_first_break(), null, 'audit hash chain is intact');
set timezone = 'Africa/Douala';
select pg_temp.assert_eq(public.audit_chain_first_break(), null, 'audit chain check does not depend on time zone');
reset timezone;

-- Simulate an attacker with database-owner access bypassing the trigger.
begin;
alter table public.audit_event disable trigger audit_event_no_update_delete;
update public.audit_event set details = '{"reason":"tampered"}' where action = 'capture.view';
select pg_temp.assert_eq(public.audit_chain_first_break(), (select id from public.audit_event where action = 'capture.view'), 'tampering is detected by the hash chain');
rollback;

-- Storage --------------------------------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from storage.buckets where id = 'id-captures' and not public), 1, 'ID image bucket exists and is private');
