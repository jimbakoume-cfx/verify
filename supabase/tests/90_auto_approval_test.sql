-- Automatic approval tests (PM decision 2026-10-20; supabase/migrations/20261021000000_auto_approval.sql):
-- a clean, firm test case with liveness and face match passed is approved by the system, recorded like a
-- staff decision and audited; every blocking condition leaves the case to a person; the system never
-- rejects; an admin switches it off with a new threshold version; staff can confirm or overturn an
-- automatic approval; the rider's result (flow_result); a migration's re-assessment approves nothing.
-- Run by scripts/test-db.sh after 80_m6_m7_test.sql in the same database; the ids used here (a9...) do not
-- overlap with the earlier files' fixtures.
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

create function pg_temp.id(prefix text, n integer) returns uuid language sql immutable as $$
  select (prefix || '-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.v(n integer) returns public.verification language sql stable as $$
  select * from public.verification where id = pg_temp.id('a9300000', n)
$$;
create function pg_temp.audits(n integer, action_name text) returns bigint language sql stable as $$
  select count(*) from public.audit_event ae where ae.target_id = pg_temp.id('a9300000', n)::text and ae.action = action_name
$$;
create function pg_temp.result(n integer) returns text language sql stable as $$
  select public.flow_result(pg_temp.id('a9300000', n)) ->> 'state'
$$;

-- A case as the server leaves it once every photo is checked: the photos (quality ok), the code lines read
-- by the server and by the phone with every check digit right, the classification from the code lines, the
-- dates checked from them, no policy reason. Open (in_progress) until pg_temp.submit. The worker's jobs
-- stay pending until pg_temp.finish_jobs.
create function pg_temp.make_case(n integer, doc text default 'passport', test boolean default true)
returns uuid language plpgsql as $$
declare
  v uuid := pg_temp.id('a9300000', n);
  app uuid := pg_temp.id('a9200000', n);
  sides text[] := case when doc = 'passport' then array['document_front'] else array['document_front', 'document_back'] end;
  mrz_side text := case doc when 'passport' then 'document_front' when 'cni_biometric' then 'document_back' end;
  side text;
  cap uuid;
  i integer := 0;
begin
  insert into public.applicant (id, api_client_id, external_user_id) values (app, 'a9000000-0000-0000-0000-000000000001', 'm9-rider-' || n);
  insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at, return_url)
  values (v, app, 1, 'in_progress', doc::public.document_type, test, now() + interval '1 hour', 'https://ride.example/verified?case=' || n);
  foreach side in array sides loop
    i := i + 1;
    cap := pg_temp.id('a94000' || lpad(i::text, 2, '0'), n);
    insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height, quality)
    values (cap, v, side::public.capture_kind, 'm9/' || n || '/' || side || '.jpg', 'm9-' || n || '-' || side, 'image/jpeg', 200000, 1280, 900,
            '{"server": {"validated": true, "reusedElsewhere": false}}');
    insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
    values (v, cap, 'quality_server', 'server-checks-v1', 'pass', '{"verdict": "ok", "provisional": true}');
    if side = mrz_side then
      insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details) values
        (v, cap, 'mrz_server', 'server-checks-v1', 'pass', '{"found": true}'),
        (v, cap, 'mrz', 'mrz-v1', 'pass', '{"result": "read"}');
    end if;
  end loop;
  insert into public.check_result (verification_id, check_name, check_version, outcome, details) values
    (v, 'classification', 'server-checks-v1', case when mrz_side is null then 'flag' else 'pass' end::public.check_outcome,
     jsonb_build_object('detected', doc, 'basis', case when mrz_side is null then 'keywords' else 'mrz' end)),
    (v, 'consistency', 'server-checks-v1', 'pass',
     jsonb_build_object('flags', '[]'::jsonb, 'provisional', '[]'::jsonb, 'basis', case when mrz_side is null then 'printed' else 'mrz' end,
                        'mismatches', '[]'::jsonb)),
    (v, 'document_policy', 'server-checks-v1', 'pass',
     jsonb_build_object('reasons', case when mrz_side is null then '["manual_review_document"]'::jsonb else '[]'::jsonb end));
  return v;
end $$;

create function pg_temp.finish_jobs(n integer) returns void language sql as $$
  update public.worker_job set status = 'done', lease_until = null, error_code = null, evidence = '{}'
   where verification_id = pg_temp.id('a9300000', n)
$$;
-- The policy reasons the worker's case-level decision would write.
create function pg_temp.reasons(n integer, codes text[]) returns void language sql as $$
  update public.check_result set details = jsonb_build_object('reasons', to_jsonb(codes)), outcome = 'flag'
   where verification_id = pg_temp.id('a9300000', n) and capture_id is null and check_name = 'document_policy'
$$;
-- The face worker's results (M6/M7), as their Edge Function records them.
create function pg_temp.face_results(n integer, liveness text default 'pass', face text default 'pass') returns void language sql as $$
  insert into public.check_result (verification_id, check_name, check_version, outcome, score, details) values
    (pg_temp.id('a9300000', n), 'liveness', 'liveness-eval-v1', liveness::public.check_outcome, 1, '{}'),
    (pg_temp.id('a9300000', n), 'face_match', 'face-match-v1', face::public.check_outcome, 0.62, '{}')
$$;

grant execute on function pg_temp.id(text, integer) to service_role, authenticated;
grant execute on function pg_temp.v(integer) to service_role, authenticated;
grant execute on function pg_temp.result(integer) to service_role;

-- Fixtures ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a9100000-0000-0000-0000-000000000001', 'admin@m9.test'),
  ('a9100000-0000-0000-0000-000000000002', 'supervisor@m9.test'),
  ('a9100000-0000-0000-0000-000000000003', 'reviewer@m9.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('a9100000-0000-0000-0000-000000000001', 'admin', 'M9 Admin', true),
  ('a9100000-0000-0000-0000-000000000002', 'supervisor', 'M9 Supervisor', true),
  ('a9100000-0000-0000-0000-000000000003', 'reviewer', 'M9 Reviewer', true);
insert into public.api_client (id, name, api_key_hash) values ('a9000000-0000-0000-0000-000000000001', 'm9-test-client', 'disabled:m9');

-- The PM's decision is active again: the automatic-approval version's settings (version 3).
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('a9100000-0000-0000-0000-000000000001',
    (select max(version) from public.threshold_config), (select config from public.threshold_config where version = 3),
    'Automatic approval tests: the PM decision of 2026-10-20 again') ->> 'result', 'created',
  'admin: the automatic-approval settings are active again');
commit;
create temp table auto_version as select max(version) as v from public.threshold_config;
grant select on auto_version to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 1. The approval: a clean passport, its face results landing after the submit
-- ---------------------------------------------------------------------------------------------------------
select pg_temp.make_case(1);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', 1), array['document_front']), 'ok', '1: submitted');
commit;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'review'
                                   and risk_reasons -> 'autoApproval' -> 'blockers' = '["not_recommended", "liveness_not_passed", "face_match_not_passed"]'
                             from pg_temp.v(1)),
  '1 at submit: waits for liveness and the face match');
begin;
set local role service_role;
select pg_temp.assert_text(pg_temp.result(1), 'pending', '1 at submit: the rider''s result is pending (a server check is still running)');
commit;
select pg_temp.finish_jobs(1);
select pg_temp.assert_text(pg_temp.result(1), 'review', '1: nothing left running and not approved: review');
select pg_temp.face_results(1);
select pg_temp.assert_true((select status = 'approved' and auto_approved_at is not null and decided_at is not null
                                   and risk_recommendation = 'approve' and threshold_config_version = (select v from auto_version)
                                   and risk_reasons -> 'autoApproval' = '{"eligible": true, "blockers": []}'
                                   and risk_reasons -> 'uncalibratedCounted' = '["face_match"]' and risk_reasons -> 'reviewOnly' = '[]'
                             from pg_temp.v(1)),
  '1: every condition holds: approved automatically, the uncalibrated face match listed as counted');
select pg_temp.assert_true((select d.actor_type = 'system' and d.actor_id is null and d.outcome = 'approve' and d.reason_code is null
                                   and d.note is null and d.threshold_config_version = (select v from auto_version)
                                   and d.recommendation = 'approve' and d.risk_band = 'approve' and d.risk_score = 0
                                   and d.agrees_with_recommendation
                             from public.decision d where d.verification_id = pg_temp.id('a9300000', 1)),
  '1: recorded like a staff decision: the system, the threshold version, the recommendation and score shown');
select pg_temp.assert_eq((select count(*) from public.review_task where verification_id = pg_temp.id('a9300000', 1) and status in ('open', 'assigned')), 0,
  '1: the review task is closed');
select pg_temp.assert_true((select ae.actor_type = 'system' and (ae.details ->> 'automatic')::boolean and ae.details ->> 'outcome' = 'approve'
                                   and not (ae.details ->> 'overridesAutomatic')::boolean
                             from public.audit_event ae where ae.action = 'decision.create' and ae.target_id = pg_temp.id('a9300000', 1)::text),
  '1: audited as an automatic decision');
select pg_temp.assert_true((select ae.details ->> 'thresholdVersion' = (select v from auto_version)::text and ae.details ->> 'trigger' = 'checks'
                                   and ae.details -> 'uncalibratedCounted' = '["face_match"]'
                                   and ae.details -> 'conditions' = to_jsonb(private.risk_auto_approval_blockers())
                             from public.audit_event ae where ae.action = 'decision.auto_approve' and ae.target_id = pg_temp.id('a9300000', 1)::text),
  '1: the automatic approval is audited with its version and the conditions that held (codes only)');
begin;
set local role service_role;
select pg_temp.assert_true(public.flow_result(pg_temp.id('a9300000', 1)) = '{"state": "verified", "returnUrl": "https://ride.example/verified?case=1"}',
  '1: the rider is told "verified", with the session''s return address');
commit;

-- A new CNI: the code lines are on the back.
select pg_temp.make_case(2, 'cni_biometric');
select pg_temp.finish_jobs(2);
select pg_temp.face_results(2);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', 2), array['document_front', 'document_back']), 'ok', '2: submitted');
commit;
select pg_temp.assert_true((select status = 'approved' and auto_approved_at is not null from pg_temp.v(2)),
  '2: a new CNI, its back''s code lines firm, everything passed: approved automatically at submit');

-- ---------------------------------------------------------------------------------------------------------
-- 2. Every blocking condition leaves the case to a person (never an automatic reject)
-- ---------------------------------------------------------------------------------------------------------
-- Each case: clean but for one thing, every job finished, the face results in, then submitted.
create temp table blocked (n integer, label text, blocker text);
grant select on blocked to service_role;
insert into blocked values
  (10, 'a real session', 'real_session'),
  (11, 'an old CNI (no code lines)', 'document_not_firm'),
  (12, 'the server''s code lines fail a check digit', 'document_not_firm'),
  (13, 'the dates read from print, not the code lines', 'document_not_firm'),
  (14, 'an expired document', 'document_expired'),
  (15, 'a holder under 18', 'under_18'),
  (16, 'printed text differs from the code lines', 'mrz_print_mismatch'),
  (17, 'a photo the server found poor', 'quality_not_ok'),
  (18, 'liveness failed', 'liveness_not_passed'),
  (19, 'the face match under the threshold', 'face_match_not_passed'),
  (20, 'a photo already used in another verification', 'hard_flag'),
  (21, 'firm signals over the reject cut-off', 'firm_signal'),
  (22, 'the face match missing', 'face_match_not_passed'),
  (23, 'the classification from printed words only', 'document_not_firm');
-- The real session as if the worker's switch were on (its photo checked) and, though the face match never
-- runs on a real session, with a face match: the database must still refuse to approve it on its own.
update public.worker_settings set enabled_for_real_sessions = true;
select pg_temp.make_case(n, case when n = 11 then 'cni_legacy' else 'passport' end, n <> 10) from blocked;
update public.worker_settings set enabled_for_real_sessions = false;
update public.check_result set outcome = 'flag' where verification_id = pg_temp.id('a9300000', 12) and check_name = 'mrz_server';
update public.check_result set details = details || '{"basis": "printed"}' where verification_id = pg_temp.id('a9300000', 13) and check_name = 'consistency';
select pg_temp.reasons(14, array['document_expired']);
select pg_temp.reasons(15, array['under_18']);
select pg_temp.reasons(16, array['mrz_print_mismatch']);
update public.check_result set details = '{"verdict": "poor", "provisional": true}' where verification_id = pg_temp.id('a9300000', 17) and check_name = 'quality_server';
update public.capture set quality = '{"server": {"validated": true, "reusedElsewhere": true}}' where verification_id = pg_temp.id('a9300000', 20);
select pg_temp.reasons(21, array['mrz_invalid_server', 'mrz_print_mismatch']);
update public.check_result set outcome = 'flag' where verification_id = pg_temp.id('a9300000', 23) and check_name = 'classification';
select pg_temp.finish_jobs(n) from blocked;
select pg_temp.face_results(n, case when n = 18 then 'fail' else 'pass' end, case when n = 19 then 'flag' else 'pass' end)
  from blocked where n <> 22;
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values (pg_temp.id('a9300000', 22), 'liveness', 'liveness-eval-v1', 'pass', '{}');
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', n),
         case when n = 11 then array['document_front', 'document_back'] else array['document_front'] end), 'ok', 'submitted: ' || label)
  from blocked order by n;
commit;
do $$
declare
  b record;
  v public.verification;
begin
  for b in select * from blocked order by n loop
    v := pg_temp.v(b.n);
    if v.status <> 'submitted' or v.auto_approved_at is not null
       or exists (select 1 from public.decision d where d.verification_id = v.id) then
      raise exception 'FAIL: % was decided (status %)', b.label, v.status;
    end if;
    if not coalesce(v.risk_reasons -> 'autoApproval' -> 'blockers' ? b.blocker, false)
       or (v.risk_reasons -> 'autoApproval' ->> 'eligible')::boolean then
      raise exception 'FAIL: % does not list %: %', b.label, b.blocker, v.risk_reasons -> 'autoApproval';
    end if;
    raise notice 'ok: not approved, waits for a person: % (%)', b.label, b.blocker;
  end loop;
end $$;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'reject' from pg_temp.v(21)),
  'never an automatic reject: a reject recommendation waits for a person');
select pg_temp.assert_eq((select count(*) from public.decision where verification_id::text like 'a9300000%' and actor_type = 'system' and outcome <> 'approve'), 0,
  'the system never records anything but an approval');
select pg_temp.assert_true((select risk_recommendation = 'approve' and risk_reasons -> 'autoApproval' -> 'blockers' = '["real_session"]' from pg_temp.v(10)),
  'a real session: recommended for approval (staff see it), never approved by the system');
begin;
set local role service_role;
select pg_temp.assert_true((select bool_and(pg_temp.result(n) = 'review') from blocked),
  'the rider of every blocked case is told "review" at once (nothing left that could approve it)');
commit;

-- A case still waiting for its photo check is "pending", unless a blocker no check can lift already holds.
select pg_temp.make_case(30);
select pg_temp.make_case(31);
select pg_temp.reasons(31, array['mrz_print_mismatch']);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', n), array['document_front']), 'ok', 'submitted ' || n) from (values (30), (31)) t (n);
commit;
begin;
set local role service_role;
select pg_temp.assert_text(pg_temp.result(30), 'pending', 'result: a check still running: pending');
select pg_temp.assert_text(pg_temp.result(31), 'review', 'result: printed text differs (final): review at once, even with a check running');
commit;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Admins switch it off without a redeploy
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('a9100000-0000-0000-0000-000000000001', (select v from auto_version),
    (select config from public.threshold_config where version = (select v from auto_version)) || '{"faceMatchCountsForApproval": false}',
    'Face match off for approval') ->> 'result', 'created', 'admin: the face match no longer counts');
commit;
select pg_temp.assert_true((select tc.config -> 'faceMatchCountsForApproval' = 'false' and tc.config -> 'autoDecide' = 'true'
                             from public.threshold_config tc order by tc.version desc limit 1),
  'the new version: automatic approval on, the face match not counted');
select pg_temp.assert_true((select ae.details -> 'changes' = '["faceMatchCountsForApproval"]' from public.audit_event ae
                             where ae.action = 'threshold_config.create' order by ae.id desc limit 1),
  'the change is audited as faceMatchCountsForApproval');
select pg_temp.make_case(40);
select pg_temp.finish_jobs(40);
select pg_temp.face_results(40);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', 40), array['document_front']), 'ok', '40: submitted');
select pg_temp.assert_text(pg_temp.result(40), 'review', '40: the rider is told "review"');
commit;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'review' and risk_reasons -> 'reviewOnly' = '["face_match"]'
                                   and risk_reasons -> 'reasons' ? 'review_only_check'
                                   and risk_reasons -> 'autoApproval' -> 'blockers' = '["not_recommended", "face_match_not_counted"]'
                             from pg_temp.v(40)),
  '40: the face match review-only again: review, not approved');

begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('a9100000-0000-0000-0000-000000000001', (select max(version) from public.threshold_config),
    (select config from public.threshold_config where version = (select v from auto_version)) || '{"autoDecide": false}',
    'Automatic approval off') ->> 'result', 'created', 'admin: automatic approval off, the face match counted');
commit;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'approve'
                                   and risk_reasons -> 'autoApproval' -> 'blockers' = '["auto_decide_off"]'
                             from pg_temp.v(40)),
  '40 with automatic approval off: recommended for approval, still waiting for a person');
begin;
set local role service_role;
select pg_temp.assert_text(pg_temp.result(40), 'review', '40: the rider is told "review"');
commit;

-- Switched on again: a new version re-assesses the waiting cases, and approves 40 now.
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('a9100000-0000-0000-0000-000000000001', (select max(version) from public.threshold_config),
    (select config from public.threshold_config where version = (select v from auto_version)), 'Automatic approval on again') ->> 'result', 'created',
  'admin: automatic approval on again');
commit;
select pg_temp.assert_true((select status = 'approved' and auto_approved_at is not null from pg_temp.v(40)),
  '40: approved by the re-assessment of the new version');
select pg_temp.assert_true((select status = 'submitted' from pg_temp.v(21)), '21 (reject recommendation): still waiting for a person');

-- ---------------------------------------------------------------------------------------------------------
-- 4. A migration's re-assessment approves nothing
-- ---------------------------------------------------------------------------------------------------------
select pg_temp.make_case(50);
select pg_temp.finish_jobs(50);
select pg_temp.face_results(50);
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('a9100000-0000-0000-0000-000000000001', (select max(version) from public.threshold_config),
    (select config from public.threshold_config where version = (select v from auto_version)) || '{"autoDecide": false}',
    'Off for the migration test') ->> 'result', 'created', 'admin: off for the migration test');
select pg_temp.assert_text(public.flow_submit(pg_temp.id('a9300000', 50), array['document_front']), 'ok', '50: submitted');
commit;
-- As a migration does: a version inserted directly, named after the migration, then the waiting cases re-assessed.
insert into public.threshold_config (version, config, note, created_by_migration)
select max(version) + 1, (select config from public.threshold_config where version = (select v from auto_version)), 'A migration''s version',
       '20991231000000_test_only'
  from public.threshold_config;
select private.risk_refresh_safe(pg_temp.id('a9300000', 50), 'migration');
select pg_temp.assert_true((select status = 'submitted' and risk_reasons -> 'autoApproval' ->> 'eligible' = 'true' from pg_temp.v(50)),
  '50: eligible, but a migration''s re-assessment never approves');
select private.risk_refresh_safe(pg_temp.id('a9300000', 50), 'checks');
select pg_temp.assert_true((select status = 'approved' and auto_approved_at is not null from pg_temp.v(50)),
  '50: the next ordinary assessment approves it');
do $$ begin
  insert into public.threshold_config (version, config, note, created_by_migration)
  select max(version) + 1, (select config from public.threshold_config where version = 3), 'bad name', 'not a migration' from public.threshold_config;
  raise exception 'FAIL: a version named an unknown kind of migration';
exception when check_violation then raise notice 'ok: a migration author is a migration file name';
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Staff can still confirm or overturn an automatic approval
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
do $$ begin
  perform public.staff_decide(pg_temp.id('a9300000', 1), 'a9100000-0000-0000-0000-000000000001', 'admin', 'reject', 'DOC_INVALID', 'x');
  raise exception 'FAIL: an admin overturned an automatic approval';
exception when insufficient_privilege then raise notice 'ok: an admin cannot overturn an automatic approval';
end $$;
do $$ begin
  perform public.staff_decide(pg_temp.id('a9300000', 1), 'a9100000-0000-0000-0000-000000000003', 'reviewer', 'reject', 'DOC_INVALID', 'x');
  raise exception 'FAIL: a reviewer without the case overturned it';
exception when insufficient_privilege then raise notice 'ok: a reviewer the case was not assigned to cannot overturn it';
end $$;
select pg_temp.assert_text(public.staff_decide(pg_temp.id('a9300000', 1), 'a9100000-0000-0000-0000-000000000002', 'supervisor',
    'reject', 'DOC_INVALID', null) ->> 'result', 'note_required', 'override: going against the approval needs a note');
select pg_temp.assert_true(public.staff_decide(pg_temp.id('a9300000', 1), 'a9100000-0000-0000-0000-000000000002', 'supervisor',
    'reject', 'DOC_INVALID', 'The portrait is not the person of the face check.')
    @> '{"result": "ok", "status": "rejected", "recommendation": "approve", "agreesWithRecommendation": false}',
  'override: a supervisor overturns the automatic approval, with a reason and a note');
select pg_temp.assert_text(public.staff_decide(pg_temp.id('a9300000', 1), 'a9100000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, 'Again') ->> 'result', 'already_decided', 'override: once a person has decided, the case is closed');
-- Confirming another one needs no note.
select pg_temp.assert_true(public.staff_decide(pg_temp.id('a9300000', 2), 'a9100000-0000-0000-0000-000000000002', 'supervisor',
    'approve', null, null) @> '{"result": "ok", "status": "approved", "agreesWithRecommendation": true}',
  'confirm: a supervisor confirms an automatic approval without a note');
commit;
select pg_temp.assert_true((select status = 'rejected' and auto_approved_at is not null from pg_temp.v(1)),
  'override: the case is rejected; that it was first approved automatically stays recorded');
select pg_temp.assert_eq((select count(*) from public.decision where verification_id = pg_temp.id('a9300000', 1)), 2,
  'override: both decisions are kept (the system''s, then the supervisor''s)');
select pg_temp.assert_true((select (ae.details ->> 'overridesAutomatic')::boolean and ae.details ->> 'outcome' = 'reject'
                                   and not (ae.details ? 'note') and ae.details::text not like '%portrait%'
                             from public.audit_event ae where ae.action = 'decision.create' and ae.target_id = pg_temp.id('a9300000', 1)::text
                             order by ae.id desc limit 1),
  'override: audited as overriding the automatic approval, without the note');
begin;
set local role service_role;
select pg_temp.assert_text(pg_temp.result(1), 'review', 'override: the rider''s result is no longer "verified"');
commit;

-- ---------------------------------------------------------------------------------------------------------
-- 6. What staff and the rider app can reach
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a9100000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.verification where id::text like 'a9300000%' and auto_approved_at is not null), 4,
  'staff: a supervisor reads which cases were approved automatically');
do $$ begin
  perform public.flow_result(pg_temp.id('a9300000', 2));
  raise exception 'FAIL: the dashboard role called flow_result';
exception when insufficient_privilege then raise notice 'ok: authenticated cannot call flow_result';
end $$;
rollback;
select pg_temp.assert_true(not has_function_privilege('anon', 'public.flow_result(uuid)', 'execute')
                           and has_function_privilege('service_role', 'public.flow_result(uuid)', 'execute'),
  'flow_result is for the service role only (the flow Edge Function)');
begin;
set local role service_role;
select pg_temp.assert_true(public.flow_result('a9300000-0000-0000-0000-0000000000ff') is null, 'flow_result: an unknown case');
select pg_temp.assert_true((select bool_and(k in ('state', 'returnUrl')) and count(*) = 8
                             from (select public.flow_result(pg_temp.id('a9300000', n)) as r from (values (1), (2), (30), (40)) t (n)) x
                             cross join lateral jsonb_object_keys(r) k),
  'flow_result: a state and a return address, nothing else');
commit;
do $$ begin
  update public.verification set return_url = 'http://ride.example/back' where id = pg_temp.id('a9300000', 30);
  raise exception 'FAIL: a return address without https was stored';
exception when check_violation then raise notice 'ok: a return address is https only';
end $$;
select pg_temp.assert_true((select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where p.proname in ('flow_result', 'risk_face_match_counts', 'risk_auto_approval_blockers', 'risk_refresh', 'record_decision')),
  'the new and replaced functions run with an empty search_path');

select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'risk.assess_failed'), 0, 'no assessment failed');
select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after the automatic approval tests');
