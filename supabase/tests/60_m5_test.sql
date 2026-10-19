-- M5 tests: the face check's challenges (issued, limited, replaced, service role only), the frames
-- (recorded once, with their check and audit entry, replacing an earlier face check's frames, erased
-- with the session), what staff may read (the frames and the check, never an open challenge), and the
-- submit's need for frames. Run by scripts/test-db.sh after 50_m4_test.sql in the same database; the
-- ids used here (a5...) do not overlap with the earlier files' fixtures. Any failed assertion aborts.
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

-- 13 frames of a challenge, as the Edge Function sends them: 1 at step 0, then 4 per action.
create function pg_temp.frames(verification uuid, challenge uuid, count integer default 13, tag text default 'a')
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'index', i,
    'step', case when i = 0 then 0 else least(3, (i - 1) / 4 + 1) end,
    'atMs', 900 + i * 700,
    'path', verification::text || '/liveness-' || challenge::text || '-' || lpad(i::text, 2, '0') || '.jpg',
    'sha256', encode(extensions.digest(tag || i::text, 'sha256'), 'hex'),
    'byteSize', 30000,
    'width', 360,
    'height', 480) order by i)
  from generate_series(0, count - 1) i
$$;

create function pg_temp.challenge(p_id uuid) returns public.liveness_challenge language sql stable as $$
  select * from public.liveness_challenge lc where lc.id = p_id
$$;

-- LivenessCaptureDetails as the Edge Function decides them.
create function pg_temp.details(challenge uuid, frames integer default 13, problems text[] default '{}')
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'evaluated', false,
    'challengeId', challenge,
    'actions', to_jsonb(lc.actions),
    'code', lc.code,
    'frames', frames,
    'framesPerStep', '[1, 4, 4, 4]'::jsonb,
    'durationMs', 9300,
    'serverElapsedMs', 15000,
    'maxGapMs', 700,
    'startedWithWarning', false,
    'problems', to_jsonb(problems))
  from public.liveness_challenge lc where lc.id = challenge
$$;

create function pg_temp.issue(verification uuid, code text default '482913', max integer default 5)
returns table (result text, challenge_id uuid, expires_at timestamptz) language sql as $$
  select * from public.flow_issue_liveness_challenge(verification, array['blink', 'turn_left', 'smile'], code, 600, max)
$$;

create function pg_temp.check_of(verification uuid) returns public.check_result language sql stable as $$
  select * from public.check_result cr
  where cr.verification_id = verification and cr.capture_id is null and cr.check_name = 'liveness_capture'
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.frames(uuid, uuid, integer, text) to service_role;
grant execute on function pg_temp.challenge(uuid) to service_role;
grant execute on function pg_temp.details(uuid, integer, text[]) to service_role;
grant execute on function pg_temp.issue(uuid, text, integer) to service_role;
grant execute on function pg_temp.check_of(uuid) to service_role;

-- Fixtures (as superuser) ----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a5100000-0000-0000-0000-000000000001', 'supervisor@m5.test'),
  ('a5100000-0000-0000-0000-000000000002', 'reviewer@m5.test'),
  ('a5100000-0000-0000-0000-000000000003', 'admin@m5.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('a5100000-0000-0000-0000-000000000001', 'supervisor', 'M5 Supervisor', true),
  ('a5100000-0000-0000-0000-000000000002', 'reviewer', 'M5 Reviewer', true),
  ('a5100000-0000-0000-0000-000000000003', 'admin', 'M5 Admin', true);
insert into public.api_client (id, name, api_key_hash) values ('a5000000-0000-0000-0000-000000000001', 'm5-test-client', 'disabled:m5');
insert into public.applicant (id, api_client_id, external_user_id) values
  ('a5200000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'm5-rider-1'),
  ('a5200000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000001', 'm5-rider-2'),
  ('a5200000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-000000000001', 'm5-rider-3');
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('a5300000-0000-0000-0000-000000000001', 'a5200000-0000-0000-0000-000000000001', 1, 'in_progress', 'cni_legacy', true, now() + interval '1 hour'),
  ('a5300000-0000-0000-0000-000000000002', 'a5200000-0000-0000-0000-000000000002', 1, 'in_progress', 'passport', true, now() + interval '1 hour'),
  ('a5300000-0000-0000-0000-000000000003', 'a5200000-0000-0000-0000-000000000003', 1, 'submitted', 'passport', true, now() + interval '1 hour');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height) values
  ('a5400000-0000-0000-0000-000000000011', 'a5300000-0000-0000-0000-000000000001', 'document_front', 'm5/1/front.jpg', 'm5-1-front', 'image/jpeg', 20000, 1600, 1009),
  ('a5400000-0000-0000-0000-000000000012', 'a5300000-0000-0000-0000-000000000001', 'document_back', 'm5/1/back.jpg', 'm5-1-back', 'image/jpeg', 20000, 1600, 1009);

-- The table's rules -------------------------------------------------------------------------------------
do $$
declare
  bad record;
begin
  for bad in select * from (values
    ('two actions', array['blink', 'smile']),
    ('four actions', array['blink', 'smile', 'look_up', 'turn_left']),
    ('the same action twice', array['blink', 'blink', 'smile']),
    ('an unknown action', array['blink', 'smile', 'wink']),
    ('a null action', array['blink', 'smile', null])
  ) as t(label, actions) loop
    begin
      insert into public.liveness_challenge (verification_id, actions, code, expires_at)
      values ('a5300000-0000-0000-0000-000000000001', bad.actions, '123456', now() + interval '10 minutes');
      raise exception 'FAIL: a challenge with % was stored', bad.label;
    exception when check_violation then
      raise notice 'ok: challenge refuses %', bad.label;
    end;
  end loop;
  begin
    insert into public.liveness_challenge (verification_id, actions, code, expires_at)
    values ('a5300000-0000-0000-0000-000000000001', array['blink', 'smile', 'look_up'], '12345a', now() + interval '10 minutes');
    raise exception 'FAIL: a code that is not 6 digits was stored';
  exception when check_violation then
    raise notice 'ok: challenge refuses a code that is not 6 digits';
  end;
  begin
    insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size)
    values ('a5300000-0000-0000-0000-000000000001', 'liveness_frame', 'm5/1/loose.jpg', 'm5-loose', 'image/jpeg', 30000);
    raise exception 'FAIL: a liveness frame without its challenge was stored';
  exception when check_violation then
    raise notice 'ok: a liveness frame needs its challenge';
  end;
end $$;

-- The optional "keep my face images" answer (PM, 2026-10-19) ------------------------------------------------
insert into public.consent_record (verification_id, consent_version, language)
  values ('a5300000-0000-0000-0000-000000000001', 'placeholder-v2', 'fr');
select pg_temp.assert_true((select not keep_face_images and keep_face_images_version is null from public.consent_record
    where verification_id = 'a5300000-0000-0000-0000-000000000001'),
  'consent: without an answer, face images are not kept (false, no wording version)');
insert into public.consent_record (verification_id, consent_version, language, keep_face_images, keep_face_images_version)
  values ('a5300000-0000-0000-0000-000000000002', 'placeholder-v2', 'en', true, 'placeholder-keep-faces-v1');
select pg_temp.assert_true((select keep_face_images and keep_face_images_version = 'placeholder-keep-faces-v1' from public.consent_record
    where verification_id = 'a5300000-0000-0000-0000-000000000002'),
  'consent: a yes is stored with the version of its wording');
do $$ begin
  insert into public.consent_record (verification_id, consent_version, language, keep_face_images)
    values ('a5300000-0000-0000-0000-000000000003', 'placeholder-v2', 'fr', true);
  raise exception 'FAIL: a yes without its wording version was stored';
exception when check_violation then raise notice 'ok: consent: a yes needs the version of its wording';
end $$;

-- Issuing challenges ----------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table m5_c1 on commit drop as select * from pg_temp.issue('a5300000-0000-0000-0000-000000000001');
select pg_temp.assert_true((select result = 'ok' and challenge_id is not null
    and expires_at between now() + interval '599 seconds' and now() + interval '601 seconds' from m5_c1),
  'issue: ok, with an id and an expiry 10 minutes ahead');
select pg_temp.assert_true((select lc.actions = array['blink', 'turn_left', 'smile'] and lc.code = '482913'
    and lc.used_at is null and lc.superseded_at is null from public.liveness_challenge lc join m5_c1 on lc.id = m5_c1.challenge_id),
  'issue: the actions in their order and the code are stored');
create temp table m5_ids (name text primary key, id uuid);
insert into m5_ids select 'first', challenge_id from m5_c1;
commit;

begin;
set local role service_role;
insert into m5_ids select 'second', challenge_id from pg_temp.issue('a5300000-0000-0000-0000-000000000001', '771204');
commit;
select pg_temp.assert_true((select superseded_at is not null from pg_temp.challenge((select id from m5_ids where name = 'first'))),
  'issue: a new challenge replaces the unused one before it');
select pg_temp.assert_true((select array_agg(action order by id) = array['liveness.challenge', 'liveness.challenge']
    and bool_and(target_type = 'liveness_challenge' and actor_type = 'rider')
    and bool_and(details ? 'challengeNo' and details ? 'actions' and not details::text like '%482913%' and not details::text like '%771204%')
    from public.audit_event where actor_id = 'a5300000-0000-0000-0000-000000000001'),
  'issue: each challenge is audited, never with its code');

select pg_temp.assert_text((select result from pg_temp.issue('a5300000-0000-0000-0000-000000000003')),
  'closed', 'issue: refused for a submitted session');
select pg_temp.assert_text((select result from pg_temp.issue('a5300000-0000-0000-0000-000000000001', '000000', 2)),
  'too_many', 'issue: refused once the session has had its challenges');
do $$ begin
  perform pg_temp.issue('a5300000-0000-0000-0000-000000000001', '000001', 0);
  raise exception 'FAIL: a maximum of 0 was accepted';
exception when invalid_parameter_value then raise notice 'ok: issue: refuses invalid limits';
end $$;

-- Recording frames ----------------------------------------------------------------------------------------------
create function pg_temp.record(verification uuid, challenge uuid, code text, frames jsonb default null, details jsonb default null)
returns table (result text, superseded_paths text[]) language sql as $$
  select * from public.flow_record_liveness(verification, challenge, code,
    coalesce(frames, pg_temp.frames(verification, challenge)), 'liveness-capture-v1', 'pass',
    coalesce(details, pg_temp.details(challenge)))
$$;
grant execute on function pg_temp.record(uuid, uuid, text, jsonb, jsonb) to service_role;

begin;
set local role service_role;
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000001',
    (select id from m5_ids where name = 'first'), '482913')),
  'expired', 'record: a replaced challenge is refused');
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000002',
    (select id from m5_ids where name = 'second'), '771204', pg_temp.frames('a5300000-0000-0000-0000-000000000002', (select id from m5_ids where name = 'second')))),
  'not_found', 'record: another session''s challenge is unknown');
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000001',
    (select id from m5_ids where name = 'second'), '771205')),
  'code_mismatch', 'record: a wrong code is refused');
commit;

-- Refused shapes: nothing is stored.
do $$
declare
  bad record;
  ch uuid := (select id from m5_ids where name = 'second');
  v uuid := 'a5300000-0000-0000-0000-000000000001';
begin
  for bad in select * from (values
    ('7 frames', pg_temp.frames(v, ch, 7), null::jsonb),
    ('16 frames', pg_temp.frames(v, ch, 16), null),
    ('a path of another challenge', pg_temp.frames(v, gen_random_uuid()), null),
    ('a path in another folder', pg_temp.frames('a5300000-0000-0000-0000-000000000002', ch), null),
    ('a frame too large', jsonb_set(pg_temp.frames(v, ch), '{0,byteSize}', '100001'), null),
    ('frames too large together', (select jsonb_agg(jsonb_set(f, '{byteSize}', '60000')) from jsonb_array_elements(pg_temp.frames(v, ch)) f), null),
    ('a frame too wide', jsonb_set(pg_temp.frames(v, ch), '{0,width}', '1280'), null),
    ('a step beyond the actions', jsonb_set(pg_temp.frames(v, ch), '{12,step}', '4'), null),
    ('an index that does not fit its path', jsonb_set(pg_temp.frames(v, ch), '{1,index}', '14'), null),
    ('a hash that is not hex', jsonb_set(pg_temp.frames(v, ch), '{0,sha256}', '"not-a-hash"'), null),
    ('details with a value', null, pg_temp.details(ch) || '{"face": "x"}'),
    ('details without a key', null, pg_temp.details(ch) - 'maxGapMs'),
    ('details saying it was evaluated', null, pg_temp.details(ch) || '{"evaluated": true}'),
    ('an unknown problem', null, pg_temp.details(ch) || '{"problems": ["spoof"]}'),
    ('the actions of another challenge', null, pg_temp.details(ch) || '{"actions": ["smile", "blink", "look_up"]}'),
    ('a frame count that does not match', null, pg_temp.details(ch) || '{"frames": 12}')
  ) as t(label, frames, details) loop
    begin
      perform pg_temp.record(v, ch, '771204', bad.frames, bad.details);
      raise exception 'FAIL: % was recorded', bad.label;
    exception when invalid_parameter_value then
      raise notice 'ok: record refuses %', bad.label;
    end;
  end loop;
  begin
    perform public.flow_record_liveness(v, ch, '771204', pg_temp.frames(v, ch), 'liveness-capture-v1', 'fail', pg_temp.details(ch));
    raise exception 'FAIL: an outcome of fail was recorded';
  exception when invalid_parameter_value then
    raise notice 'ok: record refuses an outcome other than pass or flag';
  end;
end $$;
select pg_temp.assert_true((select used_at is null from pg_temp.challenge((select id from m5_ids where name = 'second')))
    and not exists (select 1 from public.capture where kind = 'liveness_frame'),
  'record: a refused record changes nothing');

begin;
set local role service_role;
create temp table m5_r1 on commit drop as select * from pg_temp.record('a5300000-0000-0000-0000-000000000001',
    (select id from m5_ids where name = 'second'), '771204');
select pg_temp.assert_true((select result = 'ok' and superseded_paths = '{}' from m5_r1),
  'record: ok, nothing replaced the first time');
commit;
select pg_temp.assert_eq((select count(*) from public.capture c where c.verification_id = 'a5300000-0000-0000-0000-000000000001'
    and c.kind = 'liveness_frame' and c.deleted_at is null and c.liveness_challenge_id = (select id from m5_ids where name = 'second')), 13,
  'record: 13 live frames tied to their challenge');
select pg_temp.assert_true((select bool_and(c.mime_type = 'image/jpeg' and c.byte_size = 30000 and c.width = 360 and c.height = 480
      and c.quality -> 'liveness' ? 'step' and c.quality -> 'liveness' ? 'atMs' and c.quality #>> '{server,validated}' = 'true')
    from public.capture c where c.kind = 'liveness_frame'),
  'record: each frame''s size, step and time are kept');
select pg_temp.assert_true((select used_at is not null from pg_temp.challenge((select id from m5_ids where name = 'second'))),
  'record: the challenge is used');
select pg_temp.assert_true((select outcome = 'pass' and check_version = 'liveness-capture-v1'
      and details = pg_temp.details((select id from m5_ids where name = 'second'))
    from pg_temp.check_of('a5300000-0000-0000-0000-000000000001')),
  'record: the liveness_capture check is stored as decided');
select pg_temp.assert_true((select details = jsonb_build_object('frames', 13, 'outcome', 'pass', 'replaced', 0, 'problems', '[]'::jsonb)
    from public.audit_event where action = 'liveness.capture' and actor_id = 'a5300000-0000-0000-0000-000000000001'),
  'record: audited with counts and the outcome, never the code');
select pg_temp.assert_eq((select count(*) from public.worker_job j join public.capture c on c.id = j.capture_id where c.kind = 'liveness_frame'), 0,
  'record: no worker job for a frame (M5 evaluates nothing)');

begin;
set local role service_role;
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000001',
    (select id from m5_ids where name = 'second'), '771204')),
  'used', 'record: a challenge is used once');
commit;

-- A second face check replaces the first one's frames.
begin;
set local role service_role;
insert into m5_ids select 'third', challenge_id from pg_temp.issue('a5300000-0000-0000-0000-000000000001', '330011', 5);
create temp table m5_r2 on commit drop as select * from public.flow_record_liveness('a5300000-0000-0000-0000-000000000001',
    (select id from m5_ids where name = 'third'), '330011',
    pg_temp.frames('a5300000-0000-0000-0000-000000000001', (select id from m5_ids where name = 'third'), 9, 'b'),
    'liveness-capture-v1', 'flag',
    jsonb_set(pg_temp.details((select id from m5_ids where name = 'third'), 9, array['too_fast']), '{framesPerStep}', '[1, 4, 4, 0]'));
select pg_temp.assert_true((select result = 'ok' and cardinality(superseded_paths) = 13
      and superseded_paths[1] like 'a5300000-0000-0000-0000-000000000001/liveness-%-00.jpg' from m5_r2),
  'record: a newer face check returns the paths of the frames it replaced');
commit;
select pg_temp.assert_true((select count(*) filter (where deleted_at is null) = 9 and count(*) filter (where deleted_at is not null and superseded_by is not null) = 13
    from public.capture where kind = 'liveness_frame' and verification_id = 'a5300000-0000-0000-0000-000000000001'),
  'record: the older frames are erased and marked replaced; the newer 9 are live');
select pg_temp.assert_true((select outcome = 'flag' and details -> 'problems' = '["too_fast"]'::jsonb
    from pg_temp.check_of('a5300000-0000-0000-0000-000000000001'))
    and (select count(*) from public.check_result where check_name = 'liveness_capture'
         and verification_id = 'a5300000-0000-0000-0000-000000000001') = 1,
  'record: one liveness_capture check per case, replaced by the newer one');
select pg_temp.assert_true(exists (select 1 from private.superseded_files_left() s
    where s.storage_path like 'a5300000-0000-0000-0000-000000000001/liveness-%') is false,
  'deploy check: replaced frames with no file left are not listed');

-- An expired challenge.
begin;
set local role service_role;
insert into m5_ids select 'late', challenge_id from pg_temp.issue('a5300000-0000-0000-0000-000000000002', '909090');
commit;
update public.liveness_challenge set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
 where id = (select id from m5_ids where name = 'late');
begin;
set local role service_role;
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000002',
    (select id from m5_ids where name = 'late'), '909090',
    pg_temp.frames('a5300000-0000-0000-0000-000000000002', (select id from m5_ids where name = 'late')))),
  'expired', 'record: an expired challenge is refused');
commit;

-- Submit needs the frames (the flow function adds liveness_frame to the required kinds) ----------------------------
insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('a5300000-0000-0000-0000-000000000002', 'document_front', 'm5/2/front.jpg', 'm5-2-front', 'image/jpeg', 20000, 1600, 1009);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_submit('a5300000-0000-0000-0000-000000000002', array['document_front', 'liveness_frame']),
  'missing_sides', 'submit: the document photo alone is not enough');
insert into m5_ids select 'passport', challenge_id from pg_temp.issue('a5300000-0000-0000-0000-000000000002', '121212');
select pg_temp.assert_text((select result from pg_temp.record('a5300000-0000-0000-0000-000000000002',
    (select id from m5_ids where name = 'passport'), '121212',
    pg_temp.frames('a5300000-0000-0000-0000-000000000002', (select id from m5_ids where name = 'passport'), 13, 'c'))),
  'ok', 'record: a new challenge after an expired one');
select pg_temp.assert_text(public.flow_submit('a5300000-0000-0000-0000-000000000002', array['document_front', 'liveness_frame']),
  'ok', 'submit: with the face check''s frames, the case is submitted');
select pg_temp.assert_text((select result from pg_temp.issue('a5300000-0000-0000-0000-000000000002', '343434')),
  'closed', 'issue: refused once the case is submitted');
commit;

-- Who reads what -------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a5100000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.capture where kind = 'liveness_frame'
    and verification_id = 'a5300000-0000-0000-0000-000000000001'), 22,
  'staff: a supervisor reads the frames'' rows, as for the document photos');
select pg_temp.assert_eq((select count(*) from public.check_result where check_name = 'liveness_capture'
    and verification_id = 'a5300000-0000-0000-0000-000000000001'), 1,
  'staff: a supervisor reads the liveness_capture check');
do $$ begin
  perform 1 from public.liveness_challenge;
  raise exception 'FAIL: a supervisor read liveness_challenge';
exception when insufficient_privilege then raise notice 'ok: staff: no grant on liveness_challenge, even for a supervisor';
end $$;
rollback;
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a5100000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.capture where kind = 'liveness_frame'), 0,
  'staff: a reviewer without the case reads no frame');
select pg_temp.assert_eq((select count(*) from public.check_result where check_name = 'liveness_capture'), 0,
  'staff: ... and no liveness_capture check');
rollback;
insert into public.review_task (verification_id, status, assigned_to, assigned_at)
  values ('a5300000-0000-0000-0000-000000000001', 'assigned', 'a5100000-0000-0000-0000-000000000002', now());
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'a5100000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.capture where kind = 'liveness_frame' and deleted_at is null), 9,
  'staff: the assigned reviewer reads the live frames');
rollback;
begin;
set local role anon;
do $$ begin
  perform 1 from public.liveness_challenge;
  raise exception 'FAIL: anon read liveness_challenge';
exception when insufficient_privilege then raise notice 'ok: anon reads no challenge';
end $$;
rollback;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.liveness_challenge', 'select')
       or has_table_privilege(role_name, 'public.liveness_challenge', 'insert')
       or has_table_privilege(role_name, 'public.liveness_challenge', 'update')
       or has_table_privilege(role_name, 'public.liveness_challenge', 'delete') then
      raise exception 'FAIL: % has a right on liveness_challenge', role_name;
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(role_name, 'public.flow_issue_liveness_challenge(uuid, text[], text, integer, integer)', 'execute')
       or has_function_privilege(role_name, 'public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)', 'execute') then
      raise exception 'FAIL: % can execute a liveness RPC', role_name;
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(role_name, 'private.liveness_actions_valid(text[])', 'execute') then
      raise exception 'FAIL: % can execute private.liveness_actions_valid', role_name;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)', 'execute') then
    raise exception 'FAIL: the service role cannot record frames';
  end if;
  raise notice 'ok: the liveness table and RPCs are for the service role only';
end $$;
select pg_temp.assert_eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'liveness_challenge' and c.relrowsecurity), 1,
  'liveness_challenge has row level security on');
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('flow_issue_liveness_challenge', 'flow_record_liveness')
      and p.prosecdef and p.proconfig = array['search_path=""']), 2,
  'both RPCs are SECURITY DEFINER with an empty search_path');

-- Erased with the session -------------------------------------------------------------------------------------------------
-- The flow cascade, as the retention job (M13) will delete a session: its challenges and frames go too.
delete from public.review_task where verification_id = 'a5300000-0000-0000-0000-000000000001';
delete from public.check_result where verification_id = 'a5300000-0000-0000-0000-000000000001';
delete from public.verification where id = 'a5300000-0000-0000-0000-000000000001';
select pg_temp.assert_true(not exists (select 1 from public.liveness_challenge where verification_id = 'a5300000-0000-0000-0000-000000000001')
    and not exists (select 1 from public.capture where verification_id = 'a5300000-0000-0000-0000-000000000001'),
  'cascade: deleting a session deletes its challenges and frames');

-- Names the code relies on ---------------------------------------------------------------------------------------------
-- contract.ts LIVENESS_ACTIONS, LIVENESS_PROBLEMS and LIVENESS_DETAIL_KEYS: the same lists as the database.
select pg_temp.assert_true(position('''turn_left'', ''turn_right'', ''look_up'', ''blink'', ''smile''' in
    pg_get_functiondef('private.liveness_actions_valid(text[])'::regprocedure)) > 0,
  'the database accepts the contract''s actions, in its order');
select pg_temp.assert_true(position('''too_fast'', ''longer_than_challenge'', ''gap_too_long'', ''out_of_order'',' in
      pg_get_functiondef('public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)'::regprocedure)) > 0
    and position('''step_missing_frames'', ''duplicate_frames'', ''frames_reused''' in
      pg_get_functiondef('public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)'::regprocedure)) > 0,
  'the database accepts the contract''s problem codes, in its order');
select pg_temp.assert_true(position('''evaluated'', ''challengeId'', ''actions'', ''code'', ''frames'', ''framesPerStep'', ''durationMs'',' in
      pg_get_functiondef('public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)'::regprocedure)) > 0
    and position('''serverElapsedMs'', ''maxGapMs'', ''startedWithWarning'', ''problems''' in
      pg_get_functiondef('public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)'::regprocedure)) > 0,
  'the database accepts the contract''s detail keys, in its order');
select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after M5');
