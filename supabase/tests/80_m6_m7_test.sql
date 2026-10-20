-- M6/M7 tests: the face worker's jobs (created with the frames and with a new front, superseded with
-- them, test sessions only for the face match), its scoped keys and nonces, claims (inputs, lease, cap,
-- attempts, eligibility), the relay lookup (only the job's own inputs), the results (strict details,
-- first result wins, audited without values), the sweep, what staff may read, the training-consent
-- list, and M8: liveness and face match counted, the face match review-only under the M8 defaults (a clean
-- case is never recommended for approval, nor approved automatically, while the active version does not
-- set faceMatchCountsForApproval; the automatic approval is tested in 90_auto_approval_test.sql). Run by scripts/test-db.sh after 70_m8_test.sql
-- in the same database; the ids used here (a6...) do not overlap with the earlier files' fixtures.
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

-- 13 frames of a challenge, as the flow function records them (M5).
create function pg_temp.frames(verification uuid, challenge uuid, tag text default 'a')
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'index', i, 'step', case when i = 0 then 0 else least(3, (i - 1) / 4 + 1) end, 'atMs', 900 + i * 700,
    'path', verification::text || '/liveness-' || challenge::text || '-' || lpad(i::text, 2, '0') || '.jpg',
    'sha256', encode(extensions.digest(tag || challenge::text || i::text, 'sha256'), 'hex'),
    'byteSize', 30000, 'width', 360, 'height', 480) order by i)
  from generate_series(0, 12) i
$$;

-- A face check: a challenge issued and its frames recorded, through the M5 RPCs. Returns the challenge.
create function pg_temp.face_check(verification uuid, tag text default 'a') returns uuid
language plpgsql as $$
declare
  ch uuid;
  actions text[] := array['turn_left', 'blink', 'smile'];
begin
  select challenge_id into ch from public.flow_issue_liveness_challenge(verification, actions, '482913', 600, 5);
  perform public.flow_record_liveness(verification, ch, '482913', pg_temp.frames(verification, ch, tag), 'liveness-capture-v1', 'pass',
    jsonb_build_object('evaluated', false, 'challengeId', ch, 'actions', to_jsonb(actions), 'code', '482913', 'frames', 13,
                       'framesPerStep', '[1, 4, 4, 4]'::jsonb, 'durationMs', 9300, 'serverElapsedMs', 15000, 'maxGapMs', 700,
                       'startedWithWarning', false, 'problems', '[]'::jsonb));
  return ch;
end $$;

create function pg_temp.job(verification uuid, kind text) returns public.face_job language sql stable as $$
  select * from public.face_job fj where fj.verification_id = verification and fj.kind = $2 and fj.status <> 'superseded'
  order by fj.created_at desc, fj.id limit 1
$$;

-- LivenessDetails and FaceMatchDetails as the face Edge Function decides them.
create function pg_temp.liveness_details(challenge uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'evaluated', true, 'provisional', true, 'challengeId', challenge, 'engine', 'face-1/test',
    'actions', '[{"action": "turn_left", "result": "pass", "framesWithFace": 4, "peak": 22.5},
                 {"action": "blink", "result": "pass", "framesWithFace": 4, "peak": 0.8},
                 {"action": "smile", "result": "pass", "framesWithFace": 4, "peak": 0.7}]'::jsonb,
    'frames', 13, 'framesWithFace', 13, 'flatPlane', 'depth', 'flatPlaneScore', 0.06, 'problems', '[]'::jsonb,
    'timing', '{"ms": 900, "cold": false}'::jsonb)
$$;

create function pg_temp.match_details(document uuid, selfie uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'model', 'auraface-v1/glintr100', 'engine', 'face-1/test', 'similarity', 0.62, 'threshold', 0.35, 'lowThreshold', 0.15,
    'calibrated', false, 'reviewOnly', true, 'problems', '[]'::jsonb,
    'portrait', jsonb_build_object('captureId', document, 'box', '[0.1, 0.3, 0.15, 0.2]'::jsonb),
    'selfie', jsonb_build_object('captureId', selfie, 'box', '[0.3, 0.2, 0.4, 0.35]'::jsonb),
    'timing', '{"ms": 2100, "cold": true}'::jsonb)
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.frames(uuid, uuid, text) to service_role;
grant execute on function pg_temp.face_check(uuid, text) to service_role;
grant execute on function pg_temp.job(uuid, text) to service_role;
grant execute on function pg_temp.liveness_details(uuid) to service_role;
grant execute on function pg_temp.match_details(uuid, uuid) to service_role;

-- Fixtures (as superuser) ----------------------------------------------------------------------------------
-- A: a test passport (front and face check). B: a real passport. C: a test CNI whose front is retaken.
-- D: a test passport for M8 (server checks present). E: a real session with keep_face_images.
insert into auth.users (id, email) values
  ('a6100000-0000-0000-0000-000000000001', 'supervisor@m6.test'),
  ('a6100000-0000-0000-0000-000000000002', 'reviewer@m6.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('a6100000-0000-0000-0000-000000000001', 'supervisor', 'M6 Supervisor', true),
  ('a6100000-0000-0000-0000-000000000002', 'reviewer', 'M6 Reviewer', true);
insert into public.api_client (id, name, api_key_hash) values ('a6000000-0000-0000-0000-000000000001', 'm6-test-client', 'disabled:m6');
insert into public.applicant (id, api_client_id, external_user_id)
select ('a6200000-0000-0000-0000-00000000000' || n)::uuid, 'a6000000-0000-0000-0000-000000000001', 'm6-rider-' || n
  from generate_series(1, 5) n;
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('a6300000-0000-0000-0000-000000000001', 'a6200000-0000-0000-0000-000000000001', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('a6300000-0000-0000-0000-000000000002', 'a6200000-0000-0000-0000-000000000002', 1, 'in_progress', 'passport', false, now() + interval '1 hour'),
  ('a6300000-0000-0000-0000-000000000003', 'a6200000-0000-0000-0000-000000000003', 1, 'in_progress', 'cni_biometric', true, now() + interval '1 hour'),
  ('a6300000-0000-0000-0000-000000000004', 'a6200000-0000-0000-0000-000000000004', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('a6300000-0000-0000-0000-000000000005', 'a6200000-0000-0000-0000-000000000005', 1, 'in_progress', 'passport', false, now() + interval '1 hour');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height) values
  ('a6400000-0000-0000-0000-000000000001', 'a6300000-0000-0000-0000-000000000001', 'document_front', 'm6/a/front.jpg', 'm6-a', 'image/jpeg', 300000, 1280, 900),
  ('a6400000-0000-0000-0000-000000000002', 'a6300000-0000-0000-0000-000000000002', 'document_front', 'm6/b/front.jpg', 'm6-b', 'image/jpeg', 300000, 1280, 900),
  ('a6400000-0000-0000-0000-000000000031', 'a6300000-0000-0000-0000-000000000003', 'document_front', 'm6/c/front-1.jpg', 'm6-c1', 'image/jpeg', 300000, 1280, 807),
  ('a6400000-0000-0000-0000-000000000032', 'a6300000-0000-0000-0000-000000000003', 'document_back', 'm6/c/back.jpg', 'm6-c2', 'image/jpeg', 300000, 1280, 807),
  ('a6400000-0000-0000-0000-000000000004', 'a6300000-0000-0000-0000-000000000004', 'document_front', 'm6/d/front.jpg', 'm6-d', 'image/jpeg', 300000, 1280, 900),
  ('a6400000-0000-0000-0000-000000000005', 'a6300000-0000-0000-0000-000000000005', 'document_front', 'm6/e/front.jpg', 'm6-e', 'image/jpeg', 300000, 1280, 900);
insert into public.consent_record (verification_id, consent_version, language, keep_face_images, keep_face_images_version) values
  ('a6300000-0000-0000-0000-000000000001', 'placeholder-v2', 'fr', false, null),
  ('a6300000-0000-0000-0000-000000000005', 'placeholder-v2', 'fr', true, 'placeholder-keep-faces-v1');

-- ---------------------------------------------------------------------------------------------------------
-- Keys are scoped: a key signs for one function only
-- ---------------------------------------------------------------------------------------------------------
insert into public.worker_key (kid, public_key) values ('w-m6', repeat('A', 42) || 'B');
insert into public.worker_key (kid, public_key, scope) values ('f1', repeat('C', 42) || 'D', 'face');
select pg_temp.assert_text((select scope from public.worker_key where kid = 'w-m6'), 'documents', 'keys: the AI worker''s keys are scope documents by default');
do $$ begin
  insert into public.worker_key (kid, public_key, scope) values ('x', repeat('E', 43), 'admin');
  raise exception 'FAIL: an unknown scope was accepted';
exception when check_violation then raise notice 'ok: keys: no other scope';
end $$;
begin;
set local role service_role;
select pg_temp.assert_text(public.face_use_nonce('f1', 'f0000000000000000000000000000001', now() + interval '2 minutes'), 'ok',
  'nonce: the face key on the face function');
select pg_temp.assert_text(public.face_use_nonce('f1', 'f0000000000000000000000000000001', now() + interval '2 minutes'), 'replayed',
  'nonce: used once');
select pg_temp.assert_text(public.face_use_nonce('w-m6', 'f0000000000000000000000000000002', now() + interval '2 minutes'), 'revoked',
  'nonce: the AI worker''s key is refused by the face function');
select pg_temp.assert_text(public.worker_use_nonce('f1', 'f0000000000000000000000000000003', now() + interval '2 minutes'), 'revoked',
  'nonce: the face key is refused by the AI worker''s function');
select pg_temp.assert_text(public.worker_use_nonce('w-m6', 'f0000000000000000000000000000004', now() + interval '2 minutes'), 'ok',
  'nonce: the AI worker''s key still works there');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- Jobs are created with the frames, test sessions only for the face match
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table m6_ch on commit preserve rows as
  select 'a'::text as name, pg_temp.face_check('a6300000-0000-0000-0000-000000000001') as id
  union all select 'b', pg_temp.face_check('a6300000-0000-0000-0000-000000000002')
  union all select 'c', pg_temp.face_check('a6300000-0000-0000-0000-000000000003')
  union all select 'e', pg_temp.face_check('a6300000-0000-0000-0000-000000000005');
commit;
grant select on m6_ch to service_role, authenticated;

select pg_temp.assert_true((select status = 'pending' and challenge_id = (select id from m6_ch where name = 'a') and document_capture_id is null
                             from pg_temp.job('a6300000-0000-0000-0000-000000000001', 'liveness')),
  'jobs: a recorded face check gets a liveness job');
select pg_temp.assert_true((select status = 'pending' and document_capture_id = 'a6400000-0000-0000-0000-000000000001'
                             from pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')),
  'jobs: and a face_match job with the document front');
select pg_temp.assert_true((select status = 'failed' and error_code = 'ineligible' from pg_temp.job('a6300000-0000-0000-0000-000000000002', 'liveness'))
                       and (select status = 'failed' and error_code = 'ineligible' from pg_temp.job('a6300000-0000-0000-0000-000000000002', 'face_match')),
  'jobs: a real session gets them already failed (ineligible) while the face switch is off');
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003'), 2,
  'jobs: a CNI gets both too (its front carries the portrait)');

-- The switch: liveness for real sessions; never the face match (AuraFace: test sessions only).
begin;
update public.worker_settings set face_enabled_for_real_sessions = true;
set local role service_role;
select pg_temp.face_check('a6300000-0000-0000-0000-000000000002', 'b2');
select pg_temp.assert_true((select status = 'pending' from pg_temp.job('a6300000-0000-0000-0000-000000000002', 'liveness'))
                       and (select status = 'failed' and error_code = 'ineligible' from pg_temp.job('a6300000-0000-0000-0000-000000000002', 'face_match')),
  'switch on: a real session''s liveness runs, its face match never does');
rollback;

-- A new face check supersedes the jobs of the older one, and removes their results.
begin;
insert into public.check_result (verification_id, check_name, check_version, outcome, details)
values ('a6300000-0000-0000-0000-000000000003', 'liveness', 'liveness-eval-v1', 'pass', pg_temp.liveness_details((select id from m6_ch where name = 'c')));
set local role service_role;
select pg_temp.face_check('a6300000-0000-0000-0000-000000000003', 'c2');
reset role;
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and status = 'superseded'), 2,
  'new face check: the older check''s two jobs are superseded');
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and status = 'pending'), 2,
  'new face check: two new jobs');
select pg_temp.assert_eq((select count(*) from public.check_result where verification_id = 'a6300000-0000-0000-0000-000000000003' and check_name = 'liveness'), 0,
  'new face check: the older check''s liveness result is removed');
rollback;

-- A new front (a retake, another document) redoes the face match only.
begin;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height) values
  ('a6400000-0000-0000-0000-000000000033', 'a6300000-0000-0000-0000-000000000003', 'document_front', 'm6/c/front-2.jpg', 'm6-c3', 'image/jpeg', 300000, 1280, 807);
select pg_temp.assert_true((select status = 'superseded' from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003'
                             and kind = 'face_match' and document_capture_id = 'a6400000-0000-0000-0000-000000000031'),
  'new front: the face match of the older front is superseded');
select pg_temp.assert_true((select status = 'pending' and document_capture_id = 'a6400000-0000-0000-0000-000000000033'
                             from pg_temp.job('a6300000-0000-0000-0000-000000000003', 'face_match')),
  'new front: a face match with the newer front');
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and kind = 'liveness' and status = 'pending'), 1,
  'new front: the liveness job is untouched');
rollback;
-- A back photo changes nothing.
begin;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height) values
  ('a6400000-0000-0000-0000-000000000034', 'a6300000-0000-0000-0000-000000000003', 'document_back', 'm6/c/back-2.jpg', 'm6-c4', 'image/jpeg', 300000, 1280, 807);
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and status = 'superseded'), 0,
  'new back: no face job superseded');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------------------------------------
-- The earlier files' face checks (M5 tests) left face jobs of their own: out of the way.
update public.face_job set status = 'superseded', lease_until = null
 where verification_id::text not like 'a63%' and status in ('pending', 'claimed');
-- Only A's jobs may run first: C's are made to wait (created later, still pending after A's).
update public.face_job set created_at = now() - interval '10 minutes'
 where verification_id = 'a6300000-0000-0000-0000-000000000001';
begin;
set local role service_role;
create temp table m6_claim1 on commit drop as select public.face_claim() as c;
select pg_temp.assert_true((select c ->> 'kind' in ('liveness', 'face_match') and (c ->> 'attempt')::int = 1 and (c ->> 'testSession')::boolean
                                   and c -> 'actions' = '["turn_left", "blink", "smile"]' and c ->> 'declaredDocument' = 'passport'
                             from m6_claim1),
  'claim: the oldest job, attempt 1, with its face check''s actions');
select pg_temp.assert_true((select jsonb_array_length(c -> 'inputs') = case c ->> 'kind' when 'liveness' then 13 else 14 end
                                   and c -> 'inputs' -> 0 ->> 'role' = 'frame' and (c -> 'inputs' -> 0 ->> 'index')::int = 0
                                   and (c -> 'inputs' -> 12 ->> 'step')::int = 3 and c -> 'inputs' -> 0 ->> 'sha256' ~ '^[0-9a-f]{64}$'
                             from m6_claim1),
  'claim: the frames in index order with their step, size and hash');
reset role;
select pg_temp.assert_true((select status = 'claimed' and attempts = 1 and lease_until > now() and jsonb_array_length(inputs) >= 13
                                   and not (inputs -> 0 ? 'sha256')
                             from public.face_job where id = ((select c from m6_claim1) ->> 'jobId')::uuid),
  'claim: leased 120 s; the inputs handed out are kept with the job (ids and steps only)');
set local role service_role;
create temp table m6_claim2 on commit drop as select public.face_claim() as c;
select pg_temp.assert_true((select (c ->> 'kind') <> ((select c from m6_claim1) ->> 'kind')
                                   and c -> 'inputs' -> -1 ->> 'captureId' = case c ->> 'kind' when 'face_match' then 'a6400000-0000-0000-0000-000000000001' else c -> 'inputs' -> -1 ->> 'captureId' end
                             from m6_claim2),
  'claim: then the other job of A; a face match ends with the document front');
commit;

-- The relay lookup: only an input of the attempt holding the lease.
begin;
set local role service_role;
select pg_temp.assert_true((select result = 'ok' and storage_path like 'a6300000-0000-0000-0000-000000000001/liveness-%' and byte_size = 30000
                             from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'liveness')).id, 1,
                               (select c.id from public.capture c where c.verification_id = 'a6300000-0000-0000-0000-000000000001'
                                 and c.kind = 'liveness_frame' order by c.created_at limit 1))),
  'lookup: a frame of the job');
select pg_temp.assert_text((select result from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'liveness')).id, 1,
    'a6400000-0000-0000-0000-000000000001')), 'not_found', 'lookup: the document is not an input of the liveness job');
select pg_temp.assert_text((select result from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id, 1,
    'a6400000-0000-0000-0000-000000000002')), 'not_found', 'lookup: another case''s photo is never relayed');
select pg_temp.assert_text((select result from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id, 2,
    'a6400000-0000-0000-0000-000000000001')), 'not_found', 'lookup: another attempt');
select pg_temp.assert_text((select result from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id, 1,
    'a6400000-0000-0000-0000-000000000001')), 'ok', 'lookup: the face match''s document front');
rollback;

-- The context a result is decided against.
begin;
set local role service_role;
select pg_temp.assert_true((select ctx ->> 'kind' = 'face_match' and ctx ->> 'status' = 'claimed' and (ctx ->> 'attempts')::int = 1 and (ctx ->> 'live')::boolean
                                   and ctx ->> 'challengeId' = (select id::text from m6_ch where name = 'a') and jsonb_array_length(ctx -> 'inputs') = 14
                             from (select public.face_job_context((pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id) as ctx) x),
  'context: kind, status, attempts, live inputs and the challenge');
select pg_temp.assert_true(public.face_job_context('a6000000-0000-0000-0000-00000000dead') is null, 'context: null for an unknown job');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  job uuid := (pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id;
  frame uuid := (select (i ->> 'captureId')::uuid from public.face_job fj, jsonb_array_elements(fj.inputs) i where fj.id = job and i ->> 'role' = 'frame' limit 1);
  good jsonb := pg_temp.match_details('a6400000-0000-0000-0000-000000000001', frame);
  bad record;
begin
  for bad in select * from (values
    ('calibrated true', good || '{"calibrated": true}'),
    ('reviewOnly false', good || '{"reviewOnly": false}'),
    ('an embedding', good || '{"embedding": [0.1, 0.2]}'),
    ('a key missing', good - 'threshold'),
    ('an unknown problem', good || '{"problems": ["looks_like_someone"]}'),
    ('a name in the portrait', jsonb_set(good, '{portrait,name}', '"ESSAI"')),
    ('another document', jsonb_set(good, '{portrait,captureId}', '"a6400000-0000-0000-0000-000000000002"')),
    ('a selfie that is not a frame of the job', jsonb_set(good, '{selfie,captureId}', '"a6400000-0000-0000-0000-000000000004"'))
  ) as t (name, details) loop
    begin
      perform public.face_record_result('f1', job, 1, 'face_match', 'face-match-v1', 'pass', 0.62, bad.details, '{"similarity": 0.62}');
      raise exception 'FAIL: face_match details with % were accepted', bad.name;
    exception when invalid_parameter_value then raise notice 'ok: result: refuses face_match details with %', bad.name;
    end;
  end loop;
  begin
    perform public.face_record_result('f1', job, 1, 'liveness', 'liveness-eval-v1', 'pass', 1, pg_temp.liveness_details((select id from m6_ch where name = 'a')), '{}');
    raise exception 'FAIL: a liveness result on a face_match job was accepted';
  exception when invalid_parameter_value then raise notice 'ok: result: the check must be the job''s kind';
  end;
end $$;

begin;
set local role service_role;
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000001', 'liveness')).id, 1, 'liveness',
    'liveness-eval-v1', 'pass', 1, pg_temp.liveness_details((select id from m6_ch where name = 'a')), '{"referenceIndex": 0, "frames": []}'),
  'recorded', 'result: liveness recorded');
select pg_temp.assert_text(public.face_record_result('f1', (select fj.id from public.face_job fj where fj.verification_id = 'a6300000-0000-0000-0000-000000000001' and fj.kind = 'liveness'), 1, 'liveness',
    'liveness-eval-v1', 'fail', 0, pg_temp.liveness_details((select id from m6_ch where name = 'a')), '{}'),
  'already_done', 'result: the first result wins');
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id, 1, 'face_match',
    'face-match-v1', 'pass', 0.62,
    pg_temp.match_details('a6400000-0000-0000-0000-000000000001',
      (select (i ->> 'captureId')::uuid from public.face_job fj, jsonb_array_elements(fj.inputs) i
        where fj.id = (pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')).id and (i ->> 'index')::int = 0)),
    '{"similarity": 0.62}'),
  'recorded', 'result: face match recorded');
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000003', 'liveness')).id, 1, 'liveness',
    'liveness-eval-v1', 'pass', 1, pg_temp.liveness_details((select id from m6_ch where name = 'c')), '{}'),
  'not_found', 'result: an attempt never handed out');
commit;

select pg_temp.assert_true((select outcome = 'pass' and score = 1 and capture_id is null and check_version = 'liveness-eval-v1'
                             from public.check_result where verification_id = 'a6300000-0000-0000-0000-000000000001' and check_name = 'liveness'),
  'result: the case-level liveness check');
select pg_temp.assert_true((select outcome = 'pass' and score = 0.62 and details ->> 'calibrated' = 'false' and details ->> 'reviewOnly' = 'true'
                             from public.check_result where verification_id = 'a6300000-0000-0000-0000-000000000001' and check_name = 'face_match'),
  'result: the case-level face_match check, uncalibrated and review-only');
select pg_temp.assert_true((select status = 'done' and evidence is not null and lease_until is null
                             from pg_temp.job('a6300000-0000-0000-0000-000000000001', 'face_match')),
  'result: the job is done and keeps the measures');
select pg_temp.assert_true((select count(*) = 2 and bool_and(ae.details ?& array['jobId', 'kind', 'attempt', 'outcome'])
                                   and bool_and((select count(*) from jsonb_object_keys(ae.details)) = 4)
                             from public.audit_event ae where ae.action = 'face.result' and ae.target_id = 'a6300000-0000-0000-0000-000000000001'),
  'result: audited with the outcome only (never a score, a box or a measure)');

-- An erased input: the result is gone.
begin;
set local role service_role;
select pg_temp.assert_true(public.face_claim() ->> 'jobId' is not null and public.face_claim() ->> 'jobId' is not null, 'gone: C''s two jobs claimed');
reset role;
update public.capture set deleted_at = now()
 where liveness_challenge_id = (select id from m6_ch where name = 'c') and (quality #>> '{liveness,index}')::int = 4;
set local role service_role;
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000003', 'liveness')).id, 1, 'liveness',
    'liveness-eval-v1', 'pass', 1, pg_temp.liveness_details((select id from m6_ch where name = 'c')), '{}'),
  'gone', 'gone: a result for frames erased meanwhile is not recorded');
select pg_temp.assert_text((select result from public.face_image_lookup((pg_temp.job('a6300000-0000-0000-0000-000000000003', 'liveness')).id, 1,
    (select id from public.capture where liveness_challenge_id = (select id from m6_ch where name = 'c') and (quality #>> '{liveness,index}')::int = 4))),
  'gone', 'gone: and the erased frame is not relayed');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- Eligibility, budget and attempts at claim time
-- ---------------------------------------------------------------------------------------------------------
begin;
update public.worker_settings set face_daily_job_cap = 0;
set local role service_role;
select pg_temp.assert_true(public.face_claim() is null, 'budget: with the cap at 0 nothing is claimed');
reset role;
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and error_code = 'budget'), 2,
  'budget: the waiting jobs fail with code budget');
select pg_temp.assert_true((select count(*) > 0 from public.audit_event where action = 'face.job_failed' and details ->> 'code' = 'budget'),
  'budget: audited');
rollback;
begin;
update public.verification set status = 'cancelled' where id = 'a6300000-0000-0000-0000-000000000003';
set local role service_role;
select pg_temp.assert_true(public.face_claim() is null, 'ineligible: a closed session''s jobs are never handed out');
reset role;
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and error_code = 'ineligible'), 2,
  'ineligible: and fail with code ineligible');
rollback;
begin;
update public.face_job set attempts = 3 where verification_id = 'a6300000-0000-0000-0000-000000000003';
set local role service_role;
select pg_temp.assert_true(public.face_claim() is null, 'attempts: a job claimed 3 times is not claimed again');
rollback;
begin;
-- A real session's face match pending by mistake is still refused at claim, switch on or not.
update public.worker_settings set face_enabled_for_real_sessions = true;
update public.face_job set status = 'pending', error_code = null where verification_id = 'a6300000-0000-0000-0000-000000000002';
update public.face_job set status = 'superseded' where verification_id = 'a6300000-0000-0000-0000-000000000003';
set local role service_role;
select pg_temp.assert_text((public.face_claim() ->> 'kind'), 'liveness', 'switch on: a real session''s liveness is claimed');
select pg_temp.assert_true(public.face_claim() is null, 'switch on: its face match never is');
reset role;
select pg_temp.assert_text((select error_code from pg_temp.job('a6300000-0000-0000-0000-000000000002', 'face_match')), 'ineligible',
  'switch on: the face match fails ineligible');
rollback;

-- ---------------------------------------------------------------------------------------------------------
-- The face sweep
-- ---------------------------------------------------------------------------------------------------------
begin;
update public.face_job set status = 'claimed', attempts = 1, lease_until = now() - interval '1 second'
 where verification_id = 'a6300000-0000-0000-0000-000000000003' and kind = 'liveness';
select pg_temp.assert_true(private.face_sweep() = '{"requeued": 1, "failed": 0, "rung": true}'::jsonb, 'sweep: requeues an expired lease and rings');
select pg_temp.assert_eq((select count(*) from net.stub_http_post_calls
    where url = 'https://confiance-verify-face.vercel.app/api/process' and timeout_milliseconds = 60000), 1,
  'sweep: rings the face worker''s Vault URL');
rollback;
begin;
update public.face_job set status = 'claimed', attempts = 3, lease_until = now() - interval '1 second'
 where verification_id = 'a6300000-0000-0000-0000-000000000003';
update public.face_job set created_at = now() - interval '2 hours' where verification_id = 'a6300000-0000-0000-0000-000000000005';
select pg_temp.assert_true(private.face_sweep() @> '{"requeued": 0, "rung": false}'::jsonb, 'sweep: gives up');
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003' and error_code = 'attempts'), 2,
  'sweep: after 3 attempts');
rollback;
select pg_temp.assert_true((select count(*) = 1 from cron.job where jobname = 'face-sweep' and schedule = '* * * * *'),
  'sweep: scheduled every minute');

-- ---------------------------------------------------------------------------------------------------------
-- M8: counted; the face match never helps approve
-- ---------------------------------------------------------------------------------------------------------
-- D: a clean test passport, its photo checked by the server, then submitted; then the face results land.
insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
values ('a6300000-0000-0000-0000-000000000004', 'a6400000-0000-0000-0000-000000000004', 'quality_server', 'server-checks-v1', 'pass',
        '{"verdict": "ok", "provisional": true}');
begin;
set local role service_role;
create temp table m6_d on commit preserve rows as select pg_temp.face_check('a6300000-0000-0000-0000-000000000004', 'd') as ch;
select pg_temp.assert_text(public.flow_submit('a6300000-0000-0000-0000-000000000004', array['document_front', 'liveness_frame']), 'ok', 'D: submitted');
commit;
grant select on m6_d to service_role;
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'missing' = '["liveness", "face_match"]'
                             from public.verification where id = 'a6300000-0000-0000-0000-000000000004'),
  'M8: D at submit, before the face worker ran: liveness and face match missing');

update public.face_job set created_at = now() - interval '1 day' where verification_id = 'a6300000-0000-0000-0000-000000000004';
begin;
set local role service_role;
select pg_temp.assert_true((select array_agg(c ->> 'kind' order by c ->> 'kind') = array['face_match', 'liveness']
                             from (select public.face_claim() as c union all select public.face_claim()) x),
  'D: both jobs claimed');
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000004', 'liveness')).id, 1, 'liveness',
    'liveness-eval-v1', 'pass', 1, pg_temp.liveness_details((select ch from m6_d)), '{}'), 'recorded', 'D: liveness passed');
select pg_temp.assert_text(public.face_record_result('f1', (pg_temp.job('a6300000-0000-0000-0000-000000000004', 'face_match')).id, 1, 'face_match',
    'face-match-v1', 'pass', 0.62,
    pg_temp.match_details('a6400000-0000-0000-0000-000000000004',
      (select c.id from public.capture c where c.liveness_challenge_id = (select ch from m6_d) and (c.quality #>> '{liveness,index}')::int = 0)),
    '{}'), 'recorded', 'D: face match passed');
commit;
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'missing' = '[]' and risk_reasons ->> 'band' = 'approve'
                                   and risk_reasons -> 'reviewOnly' = '["face_match"]' and risk_reasons -> 'reasons' = '["score_low", "review_only_check"]'
                             from public.verification where id = 'a6300000-0000-0000-0000-000000000004'),
  'M8: every check present and passed, score 0: still review, the face match is review-only (uncalibrated)');

-- Automatic decisions on: still never approved.
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001',
    (select max(version) from public.threshold_config),
    (select config from public.threshold_config order by version desc limit 1) || '{"autoDecide": true}',
    'M6/M7 test: automatic decisions on') ->> 'result', 'created', 'M8: automatic decisions switched on');
commit;
select pg_temp.assert_true((select status = 'submitted' and risk_recommendation = 'review' from public.verification where id = 'a6300000-0000-0000-0000-000000000004'),
  'M8: with automatic decisions on, a clean case with a face match is never approved automatically');
select pg_temp.assert_eq((select count(*) from public.decision where verification_id = 'a6300000-0000-0000-0000-000000000004'), 0, 'M8: no system decision');

-- A failed liveness check is a provisional signal (it never rejects).
update public.check_result set outcome = 'fail' where verification_id = 'a6300000-0000-0000-0000-000000000004' and check_name = 'liveness';
select pg_temp.assert_true((select risk_recommendation = 'review' and risk_reasons -> 'contributions' @> '[{"signal": "liveness_flag", "firm": false}]'
                                   and status = 'submitted'
                             from public.verification where id = 'a6300000-0000-0000-0000-000000000004'),
  'M8: a failed liveness check adds liveness_flag (provisional): review, never an automatic reject');
begin;
set local role service_role;
select pg_temp.assert_text(public.staff_create_threshold_version('81000000-0000-0000-0000-000000000001',
    (select max(version) from public.threshold_config),
    (select config from public.threshold_config where version = 2), 'M6/M7 test: back to the defaults') ->> 'result', 'created',
  'M8: back to the defaults');
commit;
select pg_temp.assert_true(private.face_match_review_only(),
  'M8: the database still lists every face match as uncalibrated (the threshold version decides whether it counts: 90_auto_approval_test.sql)');

-- ---------------------------------------------------------------------------------------------------------
-- What staff may read
-- ---------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a6100000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000001'), 2,
  'staff: a supervisor reads the face jobs'' status');
do $$ begin
  perform evidence from public.face_job limit 1;
  raise exception 'FAIL: staff read a face job''s evidence';
exception when insufficient_privilege then raise notice 'ok: staff: never a face job''s evidence, inputs or error code';
end $$;
select pg_temp.assert_true((select count(*) = 2 from public.check_result where verification_id = 'a6300000-0000-0000-0000-000000000001'
                             and check_name in ('liveness', 'face_match')),
  'staff: a supervisor reads both checks');
rollback;
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a6100000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.face_job), 0, 'staff: a reviewer without the case reads no face job');
rollback;
begin;
set local role anon;
do $$ begin
  perform 1 from public.face_job limit 1;
  raise exception 'FAIL: anon read face_job';
exception when insufficient_privilege then raise notice 'ok: anon reads no face job';
end $$;
rollback;
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.face_claim()', 'execute')
  and not has_function_privilege('anon', 'public.face_claim()', 'execute')
  and not has_function_privilege('authenticated', 'public.face_record_result(text, uuid, integer, text, text, public.check_outcome, numeric, jsonb, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.face_image_lookup(uuid, integer, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.face_job_context(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.face_use_nonce(text, text, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.flow_face_jobs_pending(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.face_claim()', 'execute'),
  'the face RPCs are for the service role only');
select pg_temp.assert_true((select relrowsecurity from pg_class where oid = 'public.face_job'::regclass), 'face_job has row level security on');
select pg_temp.assert_true((select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where p.proname in ('face_claim', 'face_record_result', 'face_image_lookup', 'face_job_context', 'face_use_nonce',
                                                 'face_refresh_jobs', 'face_sweep', 'face_details_valid')),
  'the face functions run with an empty search_path');

-- ---------------------------------------------------------------------------------------------------------
-- Consent: only the riders who ticked "keep my face images" are listed for training
-- ---------------------------------------------------------------------------------------------------------
select pg_temp.assert_true((select array_agg(verification_id::text) = array['a6300000-0000-0000-0000-000000000005'] from private.face_training_cases()
                             where verification_id::text like 'a63%'),
  'training: only the case whose rider ticked the box');
insert into public.consent_record (verification_id, consent_version, language, keep_face_images, accepted_at)
values ('a6300000-0000-0000-0000-000000000005', 'placeholder-v2', 'fr', false, now() + interval '1 second');
select pg_temp.assert_eq((select count(*) from private.face_training_cases() where verification_id::text like 'a63%'), 0,
  'training: a later "no" removes it');

-- ---------------------------------------------------------------------------------------------------------
-- Cascade and the audit chain
-- ---------------------------------------------------------------------------------------------------------
begin;
delete from public.verification where id = 'a6300000-0000-0000-0000-000000000003';
select pg_temp.assert_eq((select count(*) from public.face_job where verification_id = 'a6300000-0000-0000-0000-000000000003'), 0,
  'cascade: deleting a session deletes its face jobs');
rollback;
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'risk.assess_failed'), 0, 'no assessment failed');
select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after M6/M7');
