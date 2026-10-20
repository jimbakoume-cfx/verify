-- Tests of the fixes after the PM's first real test (supabase/migrations/20261022000000_real_test_fixes.sql):
--   * a printed NAME that differs from trustworthy code lines is the provisional note print_name_mismatch,
--     for the consistency results stored before the fix (name in flags) and after it (in provisional); it
--     stays the firm mrz_print_mismatch when the phone did not read the same code lines, and a printed
--     number or date that differs always does;
--   * a case with only that note is still approved automatically;
--   * the speed path: the case is assessed, and approved, in the transaction that records the last face
--     check, never waiting for the sweep (private.face_sweep is never called here), and the rider's result
--     says "verified" at once;
--   * liveness-eval-v2 details (metrics) and the face checks' timings are accepted, anything else refused;
--     face_job_context gives the job's creation time.
-- Run by scripts/test-db.sh after 90_auto_approval_test.sql in the same database; the ids used here (b5...)
-- do not overlap with the earlier files' fixtures.
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
  select * from public.verification where id = pg_temp.id('b5300000', n)
$$;
create function pg_temp.signals(n integer) returns jsonb language sql stable as $$
  select private.risk_facts(pg_temp.id('b5300000', n)) -> 'signals'
$$;
grant execute on function pg_temp.id(text, integer) to service_role;
grant execute on function pg_temp.v(integer) to service_role;

-- A case as the server leaves it once its passport photo is checked (as in 90_auto_approval_test.sql): the
-- photo ok, the code lines read by the server and the phone with every check digit right, the
-- classification and dates from them. `consistency` and `reasons`: what the worker's case-level decision
-- wrote; `phone`: the outcome of the phone's report of the code lines.
create function pg_temp.make_case(n integer, consistency jsonb, reasons text[] default '{}', phone text default 'pass')
returns uuid language plpgsql as $$
declare
  v uuid := pg_temp.id('b5300000', n);
  app uuid := pg_temp.id('b5200000', n);
  cap uuid := pg_temp.id('b5400000', n);
begin
  insert into public.applicant (id, api_client_id, external_user_id) values (app, 'b5000000-0000-0000-0000-000000000001', 'rt-rider-' || n);
  insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at, return_url)
  values (v, app, 1, 'in_progress', 'passport', true, now() + interval '1 hour', 'https://ride.example/verified?case=' || n);
  insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height, quality)
  values (cap, v, 'document_front', 'rt/' || n || '/front.jpg', 'rt-' || n, 'image/jpeg', 200000, 1280, 900,
          '{"server": {"validated": true, "reusedElsewhere": false}}');
  insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details) values
    (v, cap, 'quality_server', 'server-checks-v1', 'pass', '{"verdict": "ok", "provisional": true}'),
    (v, cap, 'mrz_server', 'server-checks-v1', 'pass', '{"found": true}'),
    (v, cap, 'mrz', 'mrz-v1', phone::public.check_outcome, '{"result": "read"}');
  insert into public.check_result (verification_id, check_name, check_version, outcome, details) values
    (v, 'classification', 'server-checks-v1', 'pass', '{"detected": "passport", "basis": "mrz"}'),
    (v, 'consistency', 'server-checks-v1', case when jsonb_array_length(consistency -> 'flags') > 0 then 'flag' else 'pass' end::public.check_outcome,
     consistency),
    (v, 'document_policy', 'server-checks-v1', case when cardinality(reasons) > 0 then 'flag' else 'pass' end::public.check_outcome,
     jsonb_build_object('reasons', to_jsonb(reasons)));
  update public.worker_job set status = 'done', lease_until = null, error_code = null, evidence = '{}' where verification_id = v;
  return v;
end $$;

-- A face check recorded through the M5 RPCs (its frames create the liveness and face_match jobs).
create function pg_temp.face_check(verification uuid) returns uuid language plpgsql as $$
declare
  ch uuid;
  actions text[] := array['look_up', 'turn_left', 'smile'];
begin
  select challenge_id into ch from public.flow_issue_liveness_challenge(verification, actions, '271828', 600, 5);
  perform public.flow_record_liveness(verification, ch, '271828',
    (select jsonb_agg(jsonb_build_object(
       'index', i, 'step', case when i = 0 then 0 else least(3, (i - 1) / 4 + 1) end, 'atMs', 900 + i * 800,
       'path', verification::text || '/liveness-' || ch::text || '-' || lpad(i::text, 2, '0') || '.jpg',
       'sha256', encode(extensions.digest('rt' || ch::text || i::text, 'sha256'), 'hex'),
       'byteSize', 30000, 'width', 360, 'height', 480) order by i)
       from generate_series(0, 13) i),
    'liveness-capture-v1', 'pass',
    jsonb_build_object('evaluated', false, 'challengeId', ch, 'actions', to_jsonb(actions), 'code', '271828', 'frames', 14,
                       'framesPerStep', '[1, 4, 4, 5]'::jsonb, 'durationMs', 11300, 'serverElapsedMs', 20000, 'maxGapMs', 800,
                       'startedWithWarning', false, 'problems', '[]'::jsonb));
  return ch;
end $$;

-- What face_claim does to a job, for this job only (the earlier files may leave other jobs pending).
create function pg_temp.claim(verification uuid, job_kind text) returns uuid language plpgsql security definer as $$
declare
  job uuid;
begin
  select fj.id into job from public.face_job fj
   where fj.verification_id = verification and fj.kind = job_kind and fj.status = 'pending';
  update public.face_job fj
     set status = 'claimed', attempts = fj.attempts + 1, lease_until = now() + interval '2 minutes',
         first_claimed_at = coalesce(fj.first_claimed_at, now()), inputs = private.face_job_inputs(fj.id), updated_at = now()
   where fj.id = job;
  return job;
end $$;

-- LivenessDetails of liveness-eval-v2, with its metrics and the new timings.
create function pg_temp.liveness_v2(challenge uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'evaluated', true, 'provisional', true, 'challengeId', challenge, 'engine', 'face-1/test',
    'actions', '[{"action": "look_up", "result": "pass", "framesWithFace": 6, "peak": 10.4},
                 {"action": "turn_left", "result": "pass", "framesWithFace": 6, "peak": 34.1},
                 {"action": "smile", "result": "pass", "framesWithFace": 5, "peak": 0.71}]'::jsonb,
    'frames', 14, 'framesWithFace', 14, 'flatPlane', 'depth', 'flatPlaneScore', 0.12, 'problems', '[]'::jsonb,
    'timing', '{"ms": 410, "cold": false, "fetchMs": 900, "wallMs": 1700, "sinceJobMs": 2600}'::jsonb,
    'metrics', jsonb_build_object(
      'baseline', '{"yaw": -1.9, "pitch": -4.4, "smile": 0.004, "mouthWidth": 0.61, "eyeOpenness": 0.27}'::jsonb,
      'windows', '[[1, 2, 3, 4, 5, 6], [5, 6, 7, 8, 9, 10], [9, 10, 11, 12, 13]]'::jsonb,
      'frames', (select jsonb_agg(jsonb_build_object('index', i, 'step', case when i = 0 then 0 else least(3, (i - 1) / 4 + 1) end,
                                                     'faces', 1, 'yaw', -1.9, 'pitch', -4.4, 'blink', 0.1, 'eyeOpenness', 0.27,
                                                     'smile', null, 'mouthWidth', 0.61) order by i)
                 from generate_series(0, 13) i)))
$$;

create function pg_temp.match_details(document uuid, selfie uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'model', 'auraface-v1/glintr100', 'engine', 'face-1/test', 'similarity', 0.68, 'threshold', 0.35, 'lowThreshold', 0.15,
    'calibrated', false, 'reviewOnly', true, 'problems', '[]'::jsonb,
    'portrait', jsonb_build_object('captureId', document, 'box', '[0.1, 0.3, 0.15, 0.2]'::jsonb),
    'selfie', jsonb_build_object('captureId', selfie, 'box', '[0.3, 0.2, 0.4, 0.35]'::jsonb),
    'timing', '{"ms": 700, "cold": false, "fetchMs": 0, "wallMs": 1100, "sinceJobMs": 3900}'::jsonb)
$$;

grant execute on function pg_temp.face_check(uuid) to service_role;
grant execute on function pg_temp.claim(uuid, text) to service_role;
grant execute on function pg_temp.liveness_v2(uuid) to service_role;
grant execute on function pg_temp.match_details(uuid, uuid) to service_role;

-- Fixtures ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values ('b5100000-0000-0000-0000-000000000001', 'admin@rt.test');
insert into public.staff_profile (user_id, role, full_name, active) values ('b5100000-0000-0000-0000-000000000001', 'admin', 'RT Admin', true);
insert into public.api_client (id, name, api_key_hash) values ('b5000000-0000-0000-0000-000000000001', 'rt-test-client', 'disabled:rt');
insert into public.worker_key (kid, public_key, scope) values ('f-rt', repeat('F', 42) || 'G', 'face');

-- The real-test-fixes version's settings active again (the earlier files changed them).
begin;
set local role service_role;
select pg_temp.assert_true(public.staff_create_threshold_version('b5100000-0000-0000-0000-000000000001',
    (select max(version) from public.threshold_config),
    (select config from public.threshold_config where created_by_migration = '20261022000000_real_test_fixes'),
    'Real test fixes tests: the version of the migration again') ->> 'result' in ('created', 'unchanged'),
  'admin: the real-test-fixes settings are active (automatic approval on, the face match counted)');
commit;

-- ---------------------------------------------------------------------------------------------------------
-- 1. A printed name that differs: a provisional note when the code lines are trustworthy
-- ---------------------------------------------------------------------------------------------------------
-- 1: as stored before the fix (the PM's session): the name in consistency.flags, the reason in the policy.
select pg_temp.make_case(1, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["name"]}',
                         array['mrz_print_mismatch']);
select pg_temp.assert_true(pg_temp.signals(1) = '["print_name_mismatch"]',
  '1: a name stored as a firm flag before the fix is now the provisional note print_name_mismatch');
-- 2: the phone's reading of the code lines did not pass: the code lines are not confirmed, it stays firm.
select pg_temp.make_case(2, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["name"]}',
                         array['mrz_print_mismatch'], 'flag');
select pg_temp.assert_true(pg_temp.signals(2) = '["mrz_phone_flag", "mrz_print_mismatch"]',
  '2: without the phone''s agreeing reading, a name that differs stays firm (mrz_print_mismatch)');
-- 3: the phone and the server disagree on the code lines: firm.
select pg_temp.make_case(3, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["name"]}',
                         array['mrz_disagreement', 'mrz_print_mismatch']);
select pg_temp.assert_true(pg_temp.signals(3) = '["mrz_disagreement", "mrz_print_mismatch"]',
  '3: phone and server code lines differ: the name stays firm');
-- 4: a number that differs too: firm, whatever the name.
select pg_temp.make_case(4, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["name", "number"]}',
                         array['mrz_print_mismatch']);
select pg_temp.assert_true(pg_temp.signals(4) = '["mrz_print_mismatch"]', '4: a printed number that differs stays firm');
-- 5: a date only: firm.
select pg_temp.make_case(5, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["expiry_date"]}',
                         array['mrz_print_mismatch']);
select pg_temp.assert_true(pg_temp.signals(5) = '["mrz_print_mismatch"]', '5: a printed date that differs stays firm');
-- 6: as stored after the fix: the name in consistency.provisional, no policy reason.
select pg_temp.make_case(6, '{"flags": [], "provisional": ["mrz_print_mismatch"], "basis": "mrz", "mismatches": ["name"]}');
select pg_temp.assert_true(pg_temp.signals(6) = '["print_name_mismatch"]', '6: a name the worker notes as provisional is the note');
select pg_temp.make_case(7, '{"flags": [], "provisional": ["mrz_print_mismatch"], "basis": "mrz", "mismatches": ["name"]}', '{}', 'flag');
select pg_temp.assert_true(pg_temp.signals(7) = '["mrz_phone_flag", "mrz_print_mismatch"]',
  '7: the same without the phone''s agreeing reading: firm again');

-- ---------------------------------------------------------------------------------------------------------
-- 2. The speed path, and the note never blocks: assessed and approved when the last face check lands
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table rt_ch on commit preserve rows as select pg_temp.face_check(pg_temp.id('b5300000', 6)) as id;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('b5300000', 6), array['document_front']), 'ok', '6: submitted');
commit;
grant select on rt_ch to service_role;
select pg_temp.assert_true((select status = 'submitted' and risk_assessed_at is not null
                                   and risk_reasons -> 'autoApproval' -> 'blockers' = '["not_recommended", "liveness_not_passed", "face_match_not_passed"]'
                             from pg_temp.v(6)),
  '6 at submit: assessed at once; only the face checks are missing (the name note blocks nothing)');
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_result(pg_temp.id('b5300000', 6)) ->> 'state', 'pending', '6: the rider waits (the face jobs run)');
select pg_temp.assert_true((public.face_job_context(pg_temp.claim(pg_temp.id('b5300000', 6), 'liveness')) ->> 'createdAt')::timestamptz
                           <= now(), 'face_job_context: gives the job''s creation time (sinceJobMs)');
select pg_temp.assert_text(public.face_record_result('f-rt', (select fj.id from public.face_job fj where fj.verification_id = pg_temp.id('b5300000', 6)
                                                       and fj.kind = 'liveness' and fj.status = 'claimed'),
    1, 'liveness', 'liveness-eval-v2', 'pass', 1, pg_temp.liveness_v2((select id from rt_ch)), '{"referenceIndex": 0}'),
  'recorded', '6: liveness-eval-v2 details with metrics and timings are recorded');
commit;
select pg_temp.assert_true((select status = 'submitted' from pg_temp.v(6)), '6: the liveness alone does not approve');
select pg_temp.assert_true((select cr.details -> 'metrics' -> 'frames' -> 0 ->> 'yaw' = '-1.9' and cr.details -> 'timing' ->> 'sinceJobMs' = '2600'
                             from public.check_result cr where cr.verification_id = pg_temp.id('b5300000', 6) and cr.check_name = 'liveness'),
  '6: the per-frame metrics and the timings are kept with the check');
begin;
set local role service_role;
select pg_temp.claim(pg_temp.id('b5300000', 6), 'face_match');
select pg_temp.assert_text(public.face_record_result('f-rt', (select fj.id from public.face_job fj where fj.verification_id = pg_temp.id('b5300000', 6)
                                                       and fj.kind = 'face_match' and fj.status = 'claimed'),
    1, 'face_match', 'face-match-v1', 'pass', 0.68,
    pg_temp.match_details(pg_temp.id('b5400000', 6),
                          (select c.id from public.capture c where c.verification_id = pg_temp.id('b5300000', 6) and c.kind = 'liveness_frame'
                           order by c.storage_path limit 1)),
    '{"similarity": 0.68}'),
  'recorded', '6: the face match is recorded');
-- Still inside the transaction that recorded it: the assessment runs as it commits (deferred trigger).
commit;
select pg_temp.assert_true((select status = 'approved' and auto_approved_at is not null from pg_temp.v(6)),
  '6: approved automatically as the last face check committed, with the name note (no sweep involved)');
select pg_temp.assert_true((select risk_reasons -> 'contributions' = '[{"hard": false, "firm": false, "signal": "print_name_mismatch", "weight": 0, "counted": true}]'
                             from pg_temp.v(6)),
  '6: the note is listed for staff, weight 0, provisional');
select pg_temp.assert_true((select ae.details ->> 'trigger' = 'checks' from public.audit_event ae
                             where ae.action = 'decision.auto_approve' and ae.target_id = pg_temp.id('b5300000', 6)::text),
  '6: approved by the assessment triggered by the check, not by a sweep');
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_result(pg_temp.id('b5300000', 6)) ->> 'state', 'verified', '6: the rider is told "verified" at once');
commit;

-- 1 (the PM's session's shape), submitted with failed liveness: review, never "reject" in the recommendation.
select pg_temp.make_case(8, '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["name"]}',
                         array['mrz_print_mismatch']);
insert into public.check_result (verification_id, check_name, check_version, outcome, score, details) values
  (pg_temp.id('b5300000', 8), 'liveness', 'liveness-eval-v1', 'fail', 0, '{}'),
  (pg_temp.id('b5300000', 8), 'face_match', 'face-match-v1', 'pass', 0.679, '{}');
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit(pg_temp.id('b5300000', 8), array['document_front']), 'ok', '8: submitted');
commit;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'review' and risk_score = 0.5
                                   and risk_reasons ->> 'band' = 'review'
                                   and risk_reasons -> 'autoApproval' -> 'blockers' = '["not_recommended", "liveness_not_passed", "score_above_cutoff"]'
                             from pg_temp.v(8)),
  '8 (the PM''s session after the fix): score 0.5, review; only the liveness blocks the approval');

-- ---------------------------------------------------------------------------------------------------------
-- 3. The details: metrics and timings, nothing else
-- ---------------------------------------------------------------------------------------------------------
select pg_temp.assert_true(private.face_details_valid('liveness', pg_temp.liveness_v2(gen_random_uuid())), 'details: liveness v2 accepted');
select pg_temp.assert_true(private.face_details_valid('liveness', pg_temp.liveness_v2(gen_random_uuid()) - 'metrics'),
  'details: liveness v1 (no metrics) still accepted');
select pg_temp.assert_true(not private.face_details_valid('liveness',
    jsonb_set(pg_temp.liveness_v2(gen_random_uuid()), '{metrics,frames,0,landmarks}', '[[1, 2, 3]]')),
  'details: a frame metric with another key (a landmark) is refused');
select pg_temp.assert_true(not private.face_details_valid('liveness',
    jsonb_set(pg_temp.liveness_v2(gen_random_uuid()), '{metrics,frames,0,yaw}', '"left"')),
  'details: a frame metric that is not a number is refused');
select pg_temp.assert_true(not private.face_details_valid('liveness',
    jsonb_set(pg_temp.liveness_v2(gen_random_uuid()), '{metrics,extra}', '{}')),
  'details: metrics with another key are refused');
select pg_temp.assert_true(not private.face_details_valid('liveness',
    jsonb_set(pg_temp.liveness_v2(gen_random_uuid()), '{timing,photo}', '1')),
  'details: a timing with another key is refused');
select pg_temp.assert_true(not private.face_details_valid('liveness',
    jsonb_set(pg_temp.liveness_v2(gen_random_uuid()), '{timing}', '{"ms": 1}')),
  'details: a timing without cold is refused');
select pg_temp.assert_true(not private.face_details_valid('face_match',
    jsonb_set(pg_temp.match_details(gen_random_uuid(), gen_random_uuid()), '{metrics}', '{}')),
  'details: a face match never carries metrics');
select pg_temp.assert_true(private.face_details_valid('face_match',
    jsonb_set(pg_temp.match_details(gen_random_uuid(), gen_random_uuid()), '{timing}', '{"ms": 700, "cold": true}')),
  'details: a face match timing of the first worker still accepted');
