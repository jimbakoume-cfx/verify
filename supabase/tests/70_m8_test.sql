-- M8 tests: the risk rules (the shared vectors, also run by risk.test.ts), threshold versions
-- (append-only, valid, numbered; only an admin adds one, through staff_create_threshold_version), the
-- assessment of a case (at submit, when a late check lands, when a new version is created; deterministic;
-- never for an open or decided case), staff decisions (access, reasons, notes, agreement with the
-- recommendation, the case closed and audited) and automatic decisions (off by default; test sessions
-- only; never an approval with a check missing). Run by scripts/test-db.sh after 60_m5_test.sql in the same
-- database; the ids used here (8...) do not overlap with the earlier files' fixtures. Any failed assertion
-- aborts.
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

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- The stored assessment of a case, and its audit entries.
create function pg_temp.v(id uuid) returns public.verification language sql stable as $$
  select * from public.verification where verification.id = v.id
$$;
create function pg_temp.audits(p_case uuid, action_name text) returns bigint language sql stable as $$
  select count(*) from public.audit_event ae where ae.target_id = p_case::text and ae.action = action_name
$$;
-- The active configuration with some settings changed (a jsonb merge at the top level, or a path).
create function pg_temp.active_config() returns jsonb language sql stable as $$
  select tc.config from public.threshold_config tc order by tc.version desc limit 1
$$;
create function pg_temp.active_version() returns integer language sql stable as $$
  select max(tc.version) from public.threshold_config tc
$$;
grant execute on function pg_temp.active_config() to service_role;
grant execute on function pg_temp.active_version() to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- The shared vectors (supabase/tests/risk_vectors.json, also run by supabase/functions/_shared/risk.test.ts)
-- ---------------------------------------------------------------------------------------------------------
\set vectors_file :repo_root '/supabase/tests/risk_vectors.json'
\set vectors `cat :'vectors_file'`
create temp table vectors as select :'vectors'::jsonb as doc;

select pg_temp.assert_true((select doc -> 'signals' from vectors) = to_jsonb(private.risk_signal_codes()),
  'vectors: the database knows the same signals, in the same order, as risk.ts');
select pg_temp.assert_true(
  (select doc -> 'defaultConfig' from vectors) = (select tc.config from public.threshold_config tc where tc.version = 2),
  'vectors: version 2 is DEFAULT_THRESHOLD_CONFIG of risk.ts');
select pg_temp.assert_eq((select count(*) from public.threshold_config), 2, 'thresholds: version 1 (M0) and version 2 (M8)');

do $$
declare
  vector jsonb;
  actual jsonb;
  n integer := 0;
begin
  for vector in select jsonb_array_elements(doc -> 'assessments') from vectors loop
    actual := private.risk_evaluate(vector -> 'facts', vector -> 'config');
    if actual is distinct from vector -> 'expected' then
      raise exception 'FAIL: vector "%": expected %, got %', vector ->> 'name', vector -> 'expected', actual;
    end if;
    -- Deterministic: the same inputs give the same output, here and in TypeScript.
    if private.risk_evaluate(vector -> 'facts', vector -> 'config') is distinct from actual then
      raise exception 'FAIL: vector "%" is not deterministic', vector ->> 'name';
    end if;
    n := n + 1;
  end loop;
  raise notice 'ok: vectors: % assessments give exactly the TypeScript results', n;
  n := 0;
  for vector in select jsonb_array_elements(doc -> 'configErrors') from vectors loop
    actual := to_jsonb(private.risk_config_errors(vector -> 'config'));
    if actual is distinct from vector -> 'expected' then
      raise exception 'FAIL: config vector "%": expected %, got %', vector ->> 'name', vector -> 'expected', actual;
    end if;
    n := n + 1;
  end loop;
  raise notice 'ok: vectors: % configurations get exactly the TypeScript errors', n;
end $$;

select pg_temp.assert_true(private.risk_evaluate(
    '{"declaredDocument": "passport", "signals": ["quality_poor", "mrz_print_mismatch", "quality_poor"], "missing": ["liveness"]}',
    pg_temp.active_config())
  = private.risk_evaluate(
    '{"declaredDocument": "passport", "signals": ["mrz_print_mismatch", "quality_poor"], "missing": ["liveness", "liveness"]}',
    pg_temp.active_config()),
  'rules: the order and repetition of the facts do not matter');

-- Nothing in the earlier files' runs made an assessment fail (they submit cases and record checks).
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'risk.assess_failed'), 0,
  'triggers: no assessment failed during the M1-M4 tests');

-- ---------------------------------------------------------------------------------------------------------
-- Fixtures (as superuser)
-- ---------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('81000000-0000-0000-0000-000000000001', 'admin@m8.test'),
  ('81000000-0000-0000-0000-000000000002', 'supervisor@m8.test'),
  ('81000000-0000-0000-0000-000000000003', 'reviewer@m8.test'),
  ('81000000-0000-0000-0000-000000000004', 'reviewer2@m8.test'),
  ('81000000-0000-0000-0000-000000000005', 'former-admin@m8.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('81000000-0000-0000-0000-000000000001', 'admin', 'M8 Admin', true),
  ('81000000-0000-0000-0000-000000000002', 'supervisor', 'M8 Supervisor', true),
  ('81000000-0000-0000-0000-000000000003', 'reviewer', 'M8 Reviewer', true),
  ('81000000-0000-0000-0000-000000000004', 'reviewer', 'M8 Reviewer Two', true),
  ('81000000-0000-0000-0000-000000000005', 'admin', 'M8 Former Admin', false);
insert into public.api_client (id, name, api_key_hash) values ('80000000-0000-0000-0000-000000000001', 'm8-test-client', 'disabled:m8');
insert into public.applicant (id, api_client_id, external_user_id) values
  ('82000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'm8-rider-1'),
  ('82000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000001', 'm8-rider-2'),
  ('82000000-0000-0000-0000-000000000003', '80000000-0000-0000-0000-000000000001', 'm8-rider-3'),
  ('82000000-0000-0000-0000-000000000004', '80000000-0000-0000-0000-000000000001', 'm8-rider-4'),
  ('82000000-0000-0000-0000-000000000005', '80000000-0000-0000-0000-000000000001', 'm8-rider-5'),
  ('82000000-0000-0000-0000-000000000006', '80000000-0000-0000-0000-000000000001', 'm8-rider-6');
-- A: a test passport. B: a real passport (the worker does not run: its photo is unchecked). C: a test voter
-- card (always decided by a person). D: a test passport never submitted. E: a test passport whose photo was
-- also uploaded elsewhere. F: a test passport with every check, liveness and face match included.
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('83000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000002', 1, 'in_progress', 'passport', false, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000003', '82000000-0000-0000-0000-000000000003', 1, 'in_progress', 'voter_card', true, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000004', '82000000-0000-0000-0000-000000000004', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000005', '82000000-0000-0000-0000-000000000005', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000006', '82000000-0000-0000-0000-000000000006', 1, 'in_progress', 'passport', true, now() + interval '1 hour');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height, quality) values
  ('84000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', 'document_front', 'm8/a/front.jpg', 'm8-a', 'image/jpeg', 20000, 1600, 1126, '{"server": {"validated": true, "reusedElsewhere": false}}'),
  ('84000000-0000-0000-0000-000000000002', '83000000-0000-0000-0000-000000000002', 'document_front', 'm8/b/front.jpg', 'm8-b', 'image/jpeg', 20000, 1600, 1126, '{"server": {"validated": true, "reusedElsewhere": false}}'),
  ('84000000-0000-0000-0000-000000000031', '83000000-0000-0000-0000-000000000003', 'document_front', 'm8/c/front.jpg', 'm8-c-1', 'image/jpeg', 20000, 1600, 1009, '{}'),
  ('84000000-0000-0000-0000-000000000032', '83000000-0000-0000-0000-000000000003', 'document_back', 'm8/c/back.jpg', 'm8-c-2', 'image/jpeg', 20000, 1600, 1009, '{}'),
  ('84000000-0000-0000-0000-000000000004', '83000000-0000-0000-0000-000000000004', 'document_front', 'm8/d/front.jpg', 'm8-d', 'image/jpeg', 20000, 1600, 1126, '{}'),
  ('84000000-0000-0000-0000-000000000005', '83000000-0000-0000-0000-000000000005', 'document_front', 'm8/e/front.jpg', 'm8-e', 'image/jpeg', 20000, 1600, 1126, '{"server": {"validated": true, "reusedElsewhere": true}}'),
  ('84000000-0000-0000-0000-000000000006', '83000000-0000-0000-0000-000000000006', 'document_front', 'm8/f/front.jpg', 'm8-f', 'image/jpeg', 20000, 1600, 1126, '{}');
-- The server's photo check, as the worker function records it (A, C, D, E, F; B's job is ineligible).
insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
select c.verification_id, c.id, 'quality_server', 'server-checks-v1', 'pass', '{"verdict": "ok", "provisional": true}'
  from public.capture c where c.id in ('84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000031',
    '84000000-0000-0000-0000-000000000032', '84000000-0000-0000-0000-000000000004', '84000000-0000-0000-0000-000000000005',
    '84000000-0000-0000-0000-000000000006');
-- F's placeholder checks, as M6 and M7 will write them.
insert into public.check_result (verification_id, check_name, check_version, outcome, details) values
  ('83000000-0000-0000-0000-000000000006', 'liveness', 'test', 'pass', '{}'),
  ('83000000-0000-0000-0000-000000000006', 'face_match', 'test', 'pass', '{}');

select pg_temp.assert_true((select risk_assessed_at is null and risk_recommendation is null from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'open case: checks land, but nothing is assessed before submit');

-- ---------------------------------------------------------------------------------------------------------
-- Assessment at submit
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(id, array['document_front']), 'ok', 'submit: ' || id)
  from public.verification
 where id in ('83000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000002', '83000000-0000-0000-0000-000000000005',
              '83000000-0000-0000-0000-000000000006');
select pg_temp.assert_text(public.flow_submit('83000000-0000-0000-0000-000000000003', array['document_front', 'document_back']), 'ok', 'submit: the voter card');
select pg_temp.assert_true((select risk_assessed_at is null from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'submit: the assessment runs as the transaction commits (deferred)');
commit;

select pg_temp.assert_text((select risk_recommendation::text from pg_temp.v('83000000-0000-0000-0000-000000000001')), 'review',
  'A at submit: review (liveness and face match do not exist yet)');
select pg_temp.assert_text((select risk_reasons ->> 'band' from pg_temp.v('83000000-0000-0000-0000-000000000001')), 'approve',
  'A at submit: the score alone falls in the approve band');
select pg_temp.assert_true((select risk_score = 0 and threshold_config_version = 2 and risk_assessed_at is not null
                             from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'A at submit: score 0 with threshold version 2, recorded on the case');
select pg_temp.assert_true((select risk_reasons -> 'missing' = '["liveness", "face_match"]' and risk_reasons -> 'reasons' = '["score_low", "missing_checks"]'
                             from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'A at submit: the missing checks are listed as the reason');
-- M5's liveness_capture check (frames recorded, nothing evaluated) is not the liveness check of M6.
begin;
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000001', 'liveness_capture', 'test', 'pass', '{}');
select pg_temp.assert_true((select private.risk_facts('83000000-0000-0000-0000-000000000001') -> 'missing' = '["face_match", "liveness"]'),
  'A: a liveness_capture check (M5) does not count as the liveness check');
rollback;
select pg_temp.assert_eq(pg_temp.audits('83000000-0000-0000-0000-000000000001', 'risk.assess'), 1, 'A at submit: audited once');
select pg_temp.assert_true((select ae.details = jsonb_build_object('thresholdVersion', 2, 'score', 0, 'recommendation', 'review', 'band', 'approve', 'trigger', 'submit')
                             from public.audit_event ae where ae.target_id = '83000000-0000-0000-0000-000000000001' and ae.action = 'risk.assess'),
  'A at submit: the audit entry holds the version, score, recommendation, band and trigger only');

select pg_temp.assert_true((select risk_reasons -> 'missing' = '["server_checks", "liveness", "face_match"]' and risk_recommendation = 'review'
                             from pg_temp.v('83000000-0000-0000-0000-000000000002')),
  'B (real session, worker not allowed): the server checks are missing too');
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'reasons' ? 'always_review_document'
                             from pg_temp.v('83000000-0000-0000-0000-000000000003')),
  'C (voter card): always decided by a person');
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'hardFlags' = '["image_reused"]' and risk_score = 0.6
                             from pg_temp.v('83000000-0000-0000-0000-000000000005')),
  'E: a photo also uploaded elsewhere is a hard flag');
select pg_temp.assert_true((select risk_recommendation = 'approve' and risk_reasons -> 'missing' = '[]'
                             from pg_temp.v('83000000-0000-0000-0000-000000000006')),
  'F: with every check present and clean, the recommendation is approve');
select pg_temp.assert_true((select risk_reasons ?& array['recommendation', 'band', 'score', 'firmScore', 'reasons', 'contributions',
                                                          'hardFlags', 'missing', 'unknownSignals', 'rejectReasonCode', 'approveMax', 'rejectMin']
                                   and (select count(*) from jsonb_object_keys(risk_reasons)) = 12
                             from pg_temp.v('83000000-0000-0000-0000-000000000005')),
  'stored assessment: exactly the keys of RiskAssessment (codes, weights, cut-offs; nothing read from a document)');

-- ---------------------------------------------------------------------------------------------------------
-- Late checks: the assessment follows; nothing changes, nothing is written
-- ---------------------------------------------------------------------------------------------------------
-- The worker's case-level checks land after submit: the printed text disagrees with the code lines.
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000001', 'document_policy', 'server-checks-v1', 'flag', '{"reasons": ["mrz_print_mismatch"]}');
select pg_temp.assert_true((select risk_score = 0.5 and risk_recommendation = 'review' and risk_reasons -> 'reasons' = '["score_between", "missing_checks"]'
                             from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'A after a late check: score 0.5, between the cut-offs, review');
select pg_temp.assert_eq(pg_temp.audits('83000000-0000-0000-0000-000000000001', 'risk.assess'), 2, 'A after a late check: audited again');

select pg_temp.assert_true(private.risk_refresh('83000000-0000-0000-0000-000000000001', 'test') is false,
  'determinism: assessing again without a change changes nothing');
update public.check_result set created_at = created_at where verification_id = '83000000-0000-0000-0000-000000000001';
select pg_temp.assert_eq(pg_temp.audits('83000000-0000-0000-0000-000000000001', 'risk.assess'), 2,
  'determinism: a write that changes nothing adds no audit entry');

-- B's photo: the sweep's server_unchecked stays a missing check, not a signal.
select pg_temp.assert_true((select not (risk_reasons -> 'contributions' @> '[{"signal": "server_unchecked"}]') from pg_temp.v('83000000-0000-0000-0000-000000000002')),
  'B: server_unchecked is a missing check, never a signal');

-- D was never submitted: a late check does not assess it.
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000004', 'document_policy', 'server-checks-v1', 'flag', '{"reasons": ["date_logic"]}');
select pg_temp.assert_true((select risk_assessed_at is null from pg_temp.v('83000000-0000-0000-0000-000000000004')),
  'D (open): no assessment');

-- An unknown signal (a reason a later worker may add) goes to a person.
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000006', 'document_policy', 'server-checks-v9', 'flag', '{"reasons": ["future_reason"]}');
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'unknownSignals' = '["future_reason"]'
                             from pg_temp.v('83000000-0000-0000-0000-000000000006')),
  'F with an unknown reason: review');
delete from public.check_result where verification_id = '83000000-0000-0000-0000-000000000006' and check_name = 'document_policy';
select pg_temp.assert_text((select risk_recommendation::text from pg_temp.v('83000000-0000-0000-0000-000000000006')), 'approve',
  'F after the reason is gone (a deleted check): approve again');
-- A placeholder check that ran and did not pass.
update public.check_result set outcome = 'flag' where verification_id = '83000000-0000-0000-0000-000000000006' and check_name = 'liveness';
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'contributions' @> '[{"signal": "liveness_flag"}]'
                             from pg_temp.v('83000000-0000-0000-0000-000000000006')),
  'F with liveness flagged (M6 placeholder): liveness_flag, review');
update public.check_result set outcome = 'pass' where verification_id = '83000000-0000-0000-0000-000000000006' and check_name = 'liveness';

-- ---------------------------------------------------------------------------------------------------------
-- Threshold versions: who may add one, and the table itself
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.threshold_config), 2, 'admin reads the versions');
do $$ begin
  insert into public.threshold_config (version, config, note) values (3, pg_temp.active_config(), 'direct insert');
  raise exception 'FAIL: an admin wrote a threshold version directly';
exception when insufficient_privilege then raise notice 'ok: not even an admin writes threshold_config directly';
end $$;
do $$ begin
  update public.threshold_config set note = 'edited' where version = 2;
  raise exception 'FAIL: an admin edited a threshold version';
exception when insufficient_privilege then raise notice 'ok: an admin cannot edit a version';
end $$;
do $$ begin
  perform public.staff_create_threshold_version(auth.uid(), 2, pg_temp.active_config(), 'from the browser');
  raise exception 'FAIL: the dashboard role called staff_create_threshold_version';
exception when insufficient_privilege then raise notice 'ok: authenticated cannot call staff_create_threshold_version';
end $$;
do $$ begin
  perform public.staff_decide('83000000-0000-0000-0000-000000000001', auth.uid(), 'supervisor', 'approve', null, 'x');
  raise exception 'FAIL: the dashboard role called staff_decide';
exception when insufficient_privilege then raise notice 'ok: authenticated cannot call staff_decide';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000003';
select pg_temp.assert_eq((select count(*) from public.threshold_config), 2, 'reviewer reads the versions');
do $$ begin
  delete from public.threshold_config;
  raise exception 'FAIL: a reviewer removed threshold versions';
exception when insufficient_privilege then raise notice 'ok: a reviewer cannot remove versions';
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  perform count(*) from public.threshold_config;
  raise exception 'FAIL: anon read thresholds';
exception when insufficient_privilege then raise notice 'ok: anon cannot read thresholds';
end $$;
rollback;

-- Append-only, even for the owner and the service role.
do $$ begin
  update public.threshold_config set note = 'edited' where version = 2;
  raise exception 'FAIL: a version was edited';
exception when raise_exception then raise notice 'ok: append-only: no version is edited, even by the owner';
end $$;
do $$ begin
  delete from public.threshold_config where version = 1;
  raise exception 'FAIL: a version was removed';
exception when raise_exception then raise notice 'ok: append-only: no version is removed';
end $$;
-- (CASCADE, or the foreign keys would refuse it first; the trigger then refuses the whole statement.)
set client_min_messages = warning;
do $$ begin
  truncate public.threshold_config cascade;
  raise exception 'FAIL: the versions were truncated';
exception when raise_exception then raise warning 'ok: append-only: no truncate';
end $$;
set client_min_messages = notice;
do $$ begin
  insert into public.threshold_config (version, config, note, created_by)
  values (5, pg_temp.active_config(), 'a gap in the numbers', '81000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: a version skipped a number';
exception when invalid_parameter_value then raise notice 'ok: versions follow each other without gaps';
end $$;
do $$ begin
  insert into public.threshold_config (version, config, note, created_by)
  values (3, pg_temp.active_config() - 'autoDecide', 'missing a key', '81000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: an invalid configuration was stored';
exception when invalid_parameter_value then raise notice 'ok: every stored version is valid';
end $$;
do $$ begin
  insert into public.threshold_config (version, config, note) values (3, pg_temp.active_config() || '{"rejectMin": 0.8}', 'nobody made this');
  raise exception 'FAIL: a version without its author was stored';
exception when check_violation then raise notice 'ok: a new version names who made it';
end $$;

begin;
set local role service_role;
do $$ begin
  perform public.staff_create_threshold_version('81000000-0000-0000-0000-000000000002', 2, pg_temp.active_config() || '{"rejectMin": 0.5}', 'Supervisor tries');
  raise exception 'FAIL: a supervisor created a threshold version';
exception when insufficient_privilege then raise notice 'ok: a supervisor cannot create a version';
end $$;
do $$ begin
  perform public.staff_create_threshold_version('81000000-0000-0000-0000-000000000005', 2, pg_temp.active_config() || '{"rejectMin": 0.5}', 'Former admin tries');
  raise exception 'FAIL: an inactive admin created a threshold version';
exception when insufficient_privilege then raise notice 'ok: an inactive admin cannot create a version';
end $$;
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 1,
    pg_temp.active_config() || '{"rejectMin": 0.5}', 'Edited from an old page') ->> 'result', 'stale',
  'admin: a version edited from an old base is refused (stale)');
select pg_temp.assert_true(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 2,
    pg_temp.active_config() || '{"rejectMin": 0.1}', 'Cut-offs crossed') = '{"result": "invalid", "errors": ["rejectMin:order"]}',
  'admin: an invalid configuration is refused with its errors');
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 2,
    pg_temp.active_config() || '{"rejectMin": 0.5}', '  no ') ->> 'result', 'invalid_note', 'admin: a version needs a reason');
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 2,
    jsonb_set(pg_temp.active_config(), '{hardFlags}', (select to_jsonb(array(select jsonb_array_elements_text(pg_temp.active_config() -> 'hardFlags') order by 1 desc))))
    , 'Same settings, another order') ->> 'result', 'unchanged', 'admin: the same settings in another order are no new version');
commit;
select pg_temp.assert_eq((select count(*) from public.threshold_config), 2, 'thresholds: nothing was added by the refused attempts');

-- ---------------------------------------------------------------------------------------------------------
-- The PM's test: change a threshold and see the recommendation change, with no redeploy
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
-- Every submitted, undecided case (the earlier files' ones too) gets the new version.
create temp table submitted_before as select count(*) as n from public.verification where status = 'submitted';
grant select on submitted_before to service_role;
select pg_temp.assert_true(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 2,
    jsonb_set(pg_temp.active_config() || '{"rejectMin": 0.5}', '{signals,quality_poor,enabled}', 'false'),
    'Lower the reject cut-off for the M8 test')
    = jsonb_build_object('result', 'created', 'version', 3, 'rescored', (select n from submitted_before)),
  'admin: version 3 created; every submitted, undecided case was assessed again');
commit;
select pg_temp.assert_true((select tc.created_by = '81000000-0000-0000-0000-000000000001' and tc.note = 'Lower the reject cut-off for the M8 test'
                                   and tc.config -> 'rejectMin' = '0.5'
                             from public.threshold_config tc where tc.version = 3),
  'version 3 names its author and reason');
select pg_temp.assert_true((select ae.actor_id = '81000000-0000-0000-0000-000000000001'
                                   and ae.details = '{"version": 3, "baseVersion": 2, "changes": ["rejectMin", "signals.quality_poor.enabled"]}'
                             from public.audit_event ae where ae.action = 'threshold_config.create' and ae.target_id = '3'),
  'version 3 is audited with what changed (never the note)');
select pg_temp.assert_true((select risk_recommendation = 'reject' and threshold_config_version = 3
                                   and risk_reasons ->> 'rejectReasonCode' = 'DOC_INVALID'
                             from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'A with version 3: the same case is now recommended for reject');
select pg_temp.assert_true((select ae.details ->> 'trigger' = 'thresholds' from public.audit_event ae
                             where ae.target_id = '83000000-0000-0000-0000-000000000001' and ae.action = 'risk.assess'
                             order by ae.id desc limit 1),
  'A with version 3: audited as caused by the new thresholds');
select pg_temp.assert_true((select risk_recommendation = 'review' and threshold_config_version = 3 from pg_temp.v('83000000-0000-0000-0000-000000000005')),
  'E with version 3: a hard flag still means review');
select pg_temp.assert_true((select risk_recommendation = 'approve' and threshold_config_version = 3 from pg_temp.v('83000000-0000-0000-0000-000000000006')),
  'F with version 3: still approve');
select pg_temp.assert_true((select status = 'submitted' from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'automatic decisions are off: A waits for a person');

-- ---------------------------------------------------------------------------------------------------------
-- Staff decisions
-- ---------------------------------------------------------------------------------------------------------
insert into public.review_task (verification_id, status, assigned_to, assigned_at)
select '83000000-0000-0000-0000-000000000005', 'assigned', '81000000-0000-0000-0000-000000000003', now()
 where not exists (select 1 from public.review_task where verification_id = '83000000-0000-0000-0000-000000000005' and status = 'open');
update public.review_task set status = 'assigned', assigned_to = '81000000-0000-0000-0000-000000000003', assigned_at = now()
 where verification_id = '83000000-0000-0000-0000-000000000005' and status = 'open';

begin;
set local role service_role;
do $$ begin
  perform public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 'admin', 'approve', null, 'x');
  raise exception 'FAIL: an admin decided';
exception when insufficient_privilege then raise notice 'ok: an admin cannot decide (no routine access to cases)';
end $$;
do $$ begin
  perform public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003', 'reviewer', 'approve', null, 'x');
  raise exception 'FAIL: a reviewer decided a case not assigned to them';
exception when insufficient_privilege then raise notice 'ok: a reviewer cannot decide a case not assigned to them';
end $$;
do $$ begin
  perform public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'reviewer', 'approve', null, 'x');
  raise exception 'FAIL: a role that is not the profile''s was accepted';
exception when insufficient_privilege then raise notice 'ok: the claimed role must be the staff member''s own';
end $$;
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'reject', 'NOT_A_CODE', null) ->> 'result', 'invalid_reason', 'decide: a reject needs a known reason');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'reject', null, null) ->> 'result', 'invalid_reason', 'decide: a reject needs a reason');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', 'DOC_INVALID', 'fine') ->> 'result', 'invalid_reason', 'decide: an approval carries no rider reason');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, '   ') ->> 'result', 'note_required', 'decide: approving against a reject recommendation needs a note');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, 'Not yet') ->> 'result', 'not_submitted', 'decide: an open case cannot be decided');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-0000000000ff', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, 'Who') ->> 'result', 'not_found', 'decide: an unknown case');
select pg_temp.assert_true(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, '  Printed name misread by the OCR; checked on the photo.  ')
    @> '{"result": "ok", "status": "approved", "recommendation": "reject", "agreesWithRecommendation": false, "thresholdVersion": 3}',
  'decide: the supervisor approves against the recommendation, with a note');
commit;

select pg_temp.assert_true((select d.actor_type = 'staff' and d.actor_id = '81000000-0000-0000-0000-000000000002' and d.outcome = 'approve'
                                   and d.threshold_config_version = 3 and d.recommendation = 'reject' and d.risk_band = 'reject'
                                   and d.risk_score = 0.5 and d.agrees_with_recommendation = false
                                   and d.note = 'Printed name misread by the OCR; checked on the photo.' and d.reason_code is null
                             from public.decision d where d.verification_id = '83000000-0000-0000-0000-000000000001'),
  'decision: recorded with the threshold version, the recommendation, band and score shown, and the disagreement');
select pg_temp.assert_true((select status = 'approved' and decided_at is not null from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'decision: the case is approved');
select pg_temp.assert_eq((select count(*) from public.review_task where verification_id = '83000000-0000-0000-0000-000000000001' and status in ('open', 'assigned')), 0,
  'decision: the review task is closed');
select pg_temp.assert_true((select ae.actor_id = '81000000-0000-0000-0000-000000000002' and ae.details ->> 'outcome' = 'approve'
                                   and ae.details ->> 'hasNote' = 'true' and not (ae.details ? 'note')
                                   and ae.details::text not like '%OCR%'
                             from public.audit_event ae where ae.action = 'decision.create' and ae.target_id = '83000000-0000-0000-0000-000000000001'),
  'decision: audited without the note''s text');

-- A decided case is never re-assessed.
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000001', 'liveness', 'test', 'pass', '{}');
select pg_temp.assert_true((select risk_recommendation = 'reject' and threshold_config_version = 3 from pg_temp.v('83000000-0000-0000-0000-000000000001')),
  'decided case: a late check does not change what the decision was shown');

begin;
set local role service_role;
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'reject', 'DOC_INVALID', 'Second thoughts') ->> 'result', 'already_decided', 'decide: a decided case cannot be decided again');
-- The assigned reviewer rejects E (hard flag): the recommendation was review, so there is nothing to agree with.
select pg_temp.assert_true(public.staff_decide('83000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000003', 'reviewer',
    'reject', 'DOC_NOT_ORIGINAL', null) @> '{"result": "ok", "status": "rejected", "recommendation": "review", "agreesWithRecommendation": null}',
  'decide: the assigned reviewer rejects; agreement is null for a review recommendation');
-- Approving a case with a hard flag needs a note, even when the recommendation is review. (C's server
-- checks give the voter card its manual_review_document reason, a mandatory hard flag.)
set local role postgres;
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('83000000-0000-0000-0000-000000000003', 'document_policy', 'server-checks-v1', 'flag', '{"reasons": ["manual_review_document"]}');
set constraints all immediate;
set local role service_role;
select pg_temp.assert_true((select risk_reasons -> 'hardFlags' = '["manual_review_document"]' from pg_temp.v('83000000-0000-0000-0000-000000000003')),
  'C: the voter card''s manual_review_document reason is a hard flag');
select pg_temp.assert_text(public.staff_decide('83000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, null) ->> 'result', 'note_required', 'decide: approving a case with a hard flag needs a note');
-- Approving as recommended needs no note.
select pg_temp.assert_true(public.staff_decide('83000000-0000-0000-0000-000000000006', '81000000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, null) @> '{"result": "ok", "agreesWithRecommendation": true}',
  'decide: approving as recommended needs no note and agrees');
commit;

-- What staff can read of it.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000004';
select pg_temp.assert_eq((select count(*) from public.decision where verification_id::text like '83000000%'), 0,
  'reviewer two sees no decision of cases not assigned to them');
rollback;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '81000000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.decision where verification_id::text like '83000000%' and agrees_with_recommendation is not null), 2,
  'supervisor reads the decisions and their agreement');
select pg_temp.assert_eq((select count(*) from public.verification where id::text like '83000000%' and risk_reasons is not null), 5,
  'supervisor reads each assessment');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- Automatic decisions: test sessions only, never an approval with a check missing
-- ---------------------------------------------------------------------------------------------------------
-- G: a test passport with two firm signals; H: the same, real; I: a clean test passport (liveness missing).
insert into public.applicant (id, api_client_id, external_user_id) values
  ('82000000-0000-0000-0000-000000000007', '80000000-0000-0000-0000-000000000001', 'm8-rider-7'),
  ('82000000-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000001', 'm8-rider-8'),
  ('82000000-0000-0000-0000-000000000009', '80000000-0000-0000-0000-000000000001', 'm8-rider-9');
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('83000000-0000-0000-0000-000000000007', '82000000-0000-0000-0000-000000000007', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000008', '82000000-0000-0000-0000-000000000008', 1, 'in_progress', 'passport', false, now() + interval '1 hour'),
  ('83000000-0000-0000-0000-000000000009', '82000000-0000-0000-0000-000000000009', 1, 'in_progress', 'passport', true, now() + interval '1 hour');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height) values
  ('84000000-0000-0000-0000-000000000007', '83000000-0000-0000-0000-000000000007', 'document_front', 'm8/g/front.jpg', 'm8-g', 'image/jpeg', 20000, 1600, 1126),
  ('84000000-0000-0000-0000-000000000008', '83000000-0000-0000-0000-000000000008', 'document_front', 'm8/h/front.jpg', 'm8-h', 'image/jpeg', 20000, 1600, 1126),
  ('84000000-0000-0000-0000-000000000009', '83000000-0000-0000-0000-000000000009', 'document_front', 'm8/i/front.jpg', 'm8-i', 'image/jpeg', 20000, 1600, 1126);
insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
select c.verification_id, c.id, 'quality_server', 'server-checks-v1', 'pass', '{"verdict": "ok", "provisional": true}'
  from public.capture c where c.verification_id in ('83000000-0000-0000-0000-000000000007', '83000000-0000-0000-0000-000000000008', '83000000-0000-0000-0000-000000000009');
insert into public.check_result (verification_id, check_name, check_version, outcome, details) values
  ('83000000-0000-0000-0000-000000000007', 'document_policy', 'server-checks-v1', 'flag', '{"reasons": ["mrz_invalid_server", "mrz_print_mismatch"]}'),
  ('83000000-0000-0000-0000-000000000008', 'document_policy', 'server-checks-v1', 'flag', '{"reasons": ["mrz_invalid_server", "mrz_print_mismatch"]}')
-- H is a real session: its photo's job was given up at once, which already wrote a server_unchecked reason.
on conflict (verification_id, check_name) where capture_id is null
do update set details = jsonb_build_object('reasons', (excluded.details -> 'reasons') || (public.check_result.details -> 'reasons'));

begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 3,
    pg_temp.active_config() || '{"autoDecide": true}', 'Try automatic decisions on test sessions') ->> 'result', 'created',
  'admin: version 4 turns automatic decisions on');
select pg_temp.assert_text(public.flow_submit(id, array['document_front']), 'ok', 'submit: ' || id)
  from public.verification
 where id in ('83000000-0000-0000-0000-000000000007', '83000000-0000-0000-0000-000000000008', '83000000-0000-0000-0000-000000000009');
commit;

select pg_temp.assert_true((select status = 'rejected' from pg_temp.v('83000000-0000-0000-0000-000000000007')),
  'auto: a test session recommended for reject is rejected');
select pg_temp.assert_true((select d.actor_type = 'system' and d.actor_id is null and d.reason_code = 'DOC_INVALID' and d.threshold_config_version = 4
                                   and d.agrees_with_recommendation = true
                             from public.decision d where d.verification_id = '83000000-0000-0000-0000-000000000007'),
  'auto: the system decision names its rider reason and threshold version');
select pg_temp.assert_eq(pg_temp.audits('83000000-0000-0000-0000-000000000007', 'decision.create'), 1, 'auto: audited');
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'reject' from pg_temp.v('83000000-0000-0000-0000-000000000008')),
  'auto: a real session is never decided automatically');
select pg_temp.assert_true((select status = 'submitted' and risk_reasons ->> 'band' = 'approve' from pg_temp.v('83000000-0000-0000-0000-000000000009')),
  'auto: never an approval while liveness and face match are missing');

begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001', 4,
    (select tc.config from public.threshold_config tc where tc.version = 2), 'Back to the M8 defaults') ->> 'result', 'created',
  'admin: version 5 restores the defaults (automatic decisions off)');
commit;
select pg_temp.assert_true((select status = 'submitted' and threshold_config_version = 5 and risk_recommendation = 'reject'
                             from pg_temp.v('83000000-0000-0000-0000-000000000008')),
  'H with version 5: assessed again (still reject: two firm signals reach 0.9), still waiting for a person');
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'risk.assess_failed'), 0, 'no assessment failed');
