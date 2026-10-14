-- M3 tests: the AI worker's jobs (one per document photo, created by a trigger; a newer photo of a side
-- replaces the older one), its keys and nonces, the claim (lease, eligibility, test-only switch, daily
-- cap), the image lookup, the result (first wins, encrypted values, per-case checks under a fingerprint,
-- the phone's agreement in both orders), the sweep, flow_check_state and the new data in
-- staff_read_document_data. Run by scripts/test-db.sh after 30_m2_test.sql in the same database; the ids
-- used here (e...) do not overlap with the earlier files' fixtures. Any failed assertion aborts.
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

-- ICAO Doc 9303 specimens (fictitious state "UTO"), joined with a newline as the functions send them.
create function pg_temp.td1() returns text language sql immutable as $$
  select E'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
$$;
-- The same card read with a wrong document number check digit.
create function pg_temp.td1_bad() returns text language sql immutable as $$
  select E'I<UTOD231458908<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
$$;
-- Printed fields as the worker function stores them (WorkerFields, sub-type included).
create function pg_temp.fields() returns text language sql immutable as $$
  select '{"surname":"ERIKSSON","givenNames":"ANNA MARIA","issueDate":"2025-03-01","subtype":"refugee"}'
$$;

-- The phone's report (MrzCheckDetails, M2).
create function pg_temp.phone_read(capture uuid, valid boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source', 'mrz_phone', 'parserVersion', 'mrz-v1', 'captureId', capture, 'result', 'read', 'reason', null,
    'expectedFormat', 'TD1', 'format', 'TD1',
    'checks', jsonb_build_object('documentNumber', valid, 'birthDate', true, 'expiryDate', true, 'composite', valid),
    'documentCodeFits', true, 'datesValid', true, 'attempts', 1, 'corrections', 0,
    'engine', 'tesseract.js-7.0.0/mrz-1', 'ms', 850)
$$;
create function pg_temp.phone_unreadable(capture uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source', 'mrz_phone', 'parserVersion', 'mrz-v1', 'captureId', capture, 'result', 'unreadable',
    'reason', 'not_found', 'expectedFormat', 'TD1', 'format', null, 'checks', null,
    'documentCodeFits', null, 'datesValid', null, 'attempts', 3, 'corrections', null,
    'engine', 'tesseract.js-7.0.0/mrz-1', 'ms', null)
$$;

-- The per-photo checks as the worker function sends them (quality_server, ocr_fields, and mrz_server on
-- the side that carries the code lines). Outcomes, codes and metrics only.
create function pg_temp.capture_checks(with_mrz boolean, mrz_found boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('name', 'quality_server', 'version', 'server-checks-v1', 'outcome', 'pass', 'details',
      jsonb_build_object('verdict', 'ok', 'provisional', true, 'engine', 'worker-1/test',
        'quality', jsonb_build_object('sharpness', 40, 'glareRatio', 0.001, 'meanLuma', 140, 'documentFound', true,
                                      'documentConfidence', 0.9, 'longSide', 1600, 'textLines', 12),
        'timing', jsonb_build_object('ms', 2100, 'cold', false))),
    jsonb_build_object('name', 'ocr_fields', 'version', 'server-checks-v1', 'outcome', 'pass', 'details',
      jsonb_build_object('found', jsonb_build_array('surname', 'givenNames', 'issueDate'), 'provisional', true)))
  || case when with_mrz then jsonb_build_array(
    jsonb_build_object('name', 'mrz_server', 'version', 'mrz-v1', 'outcome', case when mrz_found then 'pass' else 'flag' end,
      'details', jsonb_build_object('parserVersion', 'mrz-v1', 'found', mrz_found, 'format', case when mrz_found then 'TD1' end,
        'checks', case when mrz_found then jsonb_build_object('documentNumber', true, 'birthDate', true, 'expiryDate', true,
                                                              'composite', true) end,
        'documentCodeFits', case when mrz_found then true end, 'datesValid', case when mrz_found then true end,
        'corrections', 0, 'phone', 'missing')))
  else '[]'::jsonb end
$$;

-- The case-level checks the worker function decides.
create function pg_temp.case_checks(reasons text[], detected text default 'cni_biometric') returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'version', 'server-checks-v1',
    'classification', jsonb_build_object('outcome', 'pass', 'score', 1, 'details', jsonb_build_object(
      'detected', detected, 'basis', 'mrz', 'provisional', false, 'matchesDeclared', true, 'confidence', 1,
      'qrPresent', true)),
    'reasons', to_jsonb(reasons))
$$;

create function pg_temp.evidence() returns jsonb language sql immutable as $$
  select '{"mrz": {"family": "cni_biometric", "valid": true}, "expectedMrzFound": true, "expectedMrzValid": true, "keywordHits": {"national_id": 1}, "qrPresent": true, "orientation": null}'::jsonb
$$;

create function pg_temp.job_of(capture uuid) returns uuid language sql stable as $$
  select j.id from public.worker_job j where j.capture_id = capture
$$;
create function pg_temp.fp(job uuid) returns text language sql stable as $$
  select public.worker_case_snapshot(null, job) ->> 'fingerprint'
$$;
create function pg_temp.case_fp(verification uuid) returns text language sql stable as $$
  select public.worker_case_snapshot(verification) ->> 'fingerprint'
$$;
create function pg_temp.policy(verification uuid) returns jsonb language sql stable as $$
  select cr.details -> 'reasons' from public.check_result cr
  where cr.verification_id = verification and cr.capture_id is null and cr.check_name = 'document_policy'
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.td1() to service_role;
grant execute on function pg_temp.td1_bad() to service_role;
grant execute on function pg_temp.fields() to service_role;
grant execute on function pg_temp.phone_read(uuid, boolean) to service_role;
grant execute on function pg_temp.phone_unreadable(uuid) to service_role;
grant execute on function pg_temp.capture_checks(boolean, boolean) to service_role;
grant execute on function pg_temp.case_checks(text[], text) to service_role;
grant execute on function pg_temp.evidence() to service_role;
grant execute on function pg_temp.job_of(uuid) to service_role;
grant execute on function pg_temp.fp(uuid) to service_role;
grant execute on function pg_temp.case_fp(uuid) to service_role;
grant execute on function pg_temp.policy(uuid) to service_role;

-- The earlier files' photos are of real sessions (or were inserted with the trigger held off): no job waits.
select pg_temp.assert_eq((select count(*) from public.worker_job where status in ('pending', 'claimed')), 0,
  'precondition: no job from the earlier test files waits for the worker');

-- Schema -------------------------------------------------------------------------------------------
select pg_temp.assert_true((select bool_and(relrowsecurity) from pg_class
    where oid in ('public.worker_job'::regclass, 'public.worker_key'::regclass, 'public.worker_nonce'::regclass,
                  'public.worker_settings'::regclass)),
  'RLS is enabled on the worker tables');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public'
    and tablename in ('worker_job', 'worker_key', 'worker_nonce', 'worker_settings')), 1,
  'the worker tables have no policy but the staff read of worker_job');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename = 'worker_job'
    and cmd = 'SELECT' and roles = '{authenticated}'), 1,
  'that policy only lets signed-in staff read');
select pg_temp.assert_true(not exists (
    select 1 from unnest(array['public.worker_job', 'public.worker_key', 'public.worker_nonce', 'public.worker_settings']) t(name),
                  unnest(array['anon', 'authenticated']) r(role)
    where has_table_privilege(r.role, t.name, 'select, insert, update, delete, truncate, references, trigger')),
  'anon and authenticated have no table-wide right on the worker tables');
select pg_temp.assert_true((
    select array_agg(a.attname::text order by a.attname) from pg_attribute a
    where a.attrelid = 'public.worker_job'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.worker_job', a.attname, 'select'))
  = array['capture_id', 'status', 'verification_id'],
  'authenticated may read only the job''s photo, case and status (never its evidence or error code)');
select pg_temp.assert_true(not exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.worker_job'::regclass and a.attnum > 0 and not a.attisdropped
      and (has_column_privilege('anon', 'public.worker_job', a.attname, 'select, insert, update, references')
        or has_column_privilege('authenticated', 'public.worker_job', a.attname, 'insert, update, references'))),
  'anon reads no column of worker_job, and nobody signed in writes one');
select pg_temp.assert_eq((select count(*) from public.worker_settings where id and not enabled_for_real_sessions and daily_job_cap = 150), 1,
  'worker_settings: one row, real sessions off, 150 jobs a day');
do $$ begin
  insert into public.worker_settings (id) values (false);
  raise exception 'FAIL: a second settings row was stored';
exception when check_violation then raise notice 'ok: worker_settings holds a single row';
end $$;
select pg_temp.assert_eq((select count(*) from vault.decrypted_secrets
    where name = 'worker_ring_url' and decrypted_secret = 'https://confiance-verify-worker.vercel.app/api/process'), 1,
  'the ring URL is in Vault');
select pg_temp.assert_eq((select count(*) from cron.job
    where jobname = 'worker-sweep' and schedule = '* * * * *' and command = 'select private.worker_sweep()'), 1,
  'the sweep is scheduled every minute');
select pg_temp.assert_eq((select count(*) from pg_constraint
    where contype = 'f' and confdeltype = 'c' and conrelid = 'public.worker_job'::regclass
      and confrelid in ('public.capture'::regclass, 'public.verification'::regclass)), 2,
  'a job is deleted with its photo and its verification');
select pg_temp.assert_eq((select count(*) from pg_indexes where schemaname = 'public'
    and indexname in ('worker_job_queue_idx', 'worker_job_verification_idx', 'worker_job_capture_id_key',
                      'capture_superseded_by_idx', 'check_result_case_check_idx', 'worker_nonce_expires_idx')), 6,
  'the queue, the foreign keys and the per-case checks are indexed');

-- Fixtures (as superuser) ----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-000000000001', 'supervisor@m3.test'),
  ('e1000000-0000-0000-0000-000000000002', 'reviewer@m3.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('e1000000-0000-0000-0000-000000000001', 'supervisor', 'M3 Supervisor', true),
  ('e1000000-0000-0000-0000-000000000002', 'reviewer', 'M3 Reviewer', true);
insert into public.api_client (id, name, api_key_hash) values ('e0000000-0000-0000-0000-000000000001', 'm3-test-client', 'disabled:m3');
insert into public.applicant (id, api_client_id, external_user_id)
  values ('e2000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'm3-rider-1');
-- RFC 8032 TEST 1 public key (the test vectors' key) and a revoked one.
insert into public.worker_key (kid, public_key) values ('m3-signer', '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
insert into public.worker_key (kid, public_key, revoked_at) values ('m3-revoked', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', now());

-- 1: a test session with a new CNI (the main case); 2: a real session; 3: a submitted test session;
-- 4: a test session already in review; 5: a test session that expired before submit; 6, 8, 9: new CNIs
-- for the phone comparison; 7: for the daily cap.
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('e3000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1, 'in_progress', 'cni_biometric', true, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000001', 2, 'in_progress', 'passport', false, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000003', 'e2000000-0000-0000-0000-000000000001', 3, 'submitted', 'passport', true, now() - interval '1 minute'),
  ('e3000000-0000-0000-0000-000000000004', 'e2000000-0000-0000-0000-000000000001', 4, 'in_review', 'passport', true, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000005', 'e2000000-0000-0000-0000-000000000001', 5, 'in_progress', 'passport', true, now() - interval '1 minute'),
  ('e3000000-0000-0000-0000-000000000006', 'e2000000-0000-0000-0000-000000000001', 6, 'in_progress', 'cni_biometric', true, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000007', 'e2000000-0000-0000-0000-000000000001', 7, 'in_progress', 'cni_biometric', true, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000008', 'e2000000-0000-0000-0000-000000000001', 8, 'in_progress', 'cni_biometric', true, now() + interval '1 hour'),
  ('e3000000-0000-0000-0000-000000000009', 'e2000000-0000-0000-0000-000000000001', 9, 'in_progress', 'cni_biometric', true, now() + interval '1 hour');

-- The trigger: one job per document photo -------------------------------------------------------------
-- Separate statements, as the flow function inserts them: each gets its own time.
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000011', 'e3000000-0000-0000-0000-000000000001', 'document_front', 'm3/1/front-1.jpg', 'm3-1-front-1', 'image/jpeg', 20000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000012', 'e3000000-0000-0000-0000-000000000001', 'document_back', 'm3/1/back-1.jpg', 'm3-1-back-1', 'image/jpeg', 21000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000021', 'e3000000-0000-0000-0000-000000000002', 'document_front', 'm3/2/front-1.jpg', 'm3-2-front-1', 'image/jpeg', 20000, 1600, 1131);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size)
  values ('e4000000-0000-0000-0000-000000000019', 'e3000000-0000-0000-0000-000000000001', 'selfie', 'm3/1/selfie.jpg', 'm3-1-selfie', 'image/jpeg', 20000);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, deleted_at)
  values ('e4000000-0000-0000-0000-000000000018', 'e3000000-0000-0000-0000-000000000001', 'document_front', 'm3/1/front-erased.jpg', 'm3-1-front-erased', 'image/jpeg', 20000, now());

select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id in ('e4000000-0000-0000-0000-000000000011', 'e4000000-0000-0000-0000-000000000012')
      and verification_id = 'e3000000-0000-0000-0000-000000000001' and status = 'pending' and attempts = 0
      and lease_until is null and error_code is null and evidence is null), 2,
  'trigger: each document photo of a test session gets a pending job');
select pg_temp.assert_text((select kind::text from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000012'),
  'document_back', 'trigger: the job names its side');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id in ('e4000000-0000-0000-0000-000000000019', 'e4000000-0000-0000-0000-000000000018')), 0,
  'trigger: no job for a selfie or for a photo inserted already erased');
select pg_temp.assert_eq((select count(*) from public.capture
    where id = 'e4000000-0000-0000-0000-000000000011' and deleted_at is null and superseded_by is null), 1,
  'trigger: a photo inserted already erased replaces nothing');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000021' and status = 'failed' and error_code = 'ineligible'), 1,
  'trigger: a real session''s photo is given up at once while the switch is off');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000002') = '["server_unchecked"]'::jsonb
    and (select outcome = 'flag' and check_version = 'server-checks-v1' from public.check_result
         where verification_id = 'e3000000-0000-0000-0000-000000000002' and check_name = 'document_policy'),
  'trigger: its case is flagged server_unchecked');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') is null,
  'trigger: an eligible case gets no policy before a result');
select pg_temp.assert_eq((select count(*) from public.audit_event where action like 'worker.%'
    and target_id = 'e3000000-0000-0000-0000-000000000002'), 0,
  'trigger: a job never queued is not audited');

-- Constraints -----------------------------------------------------------------------------------------
do $$
declare
  bad record;
begin
  for bad in select * from (values
    ('a failed job without a code', $sql$update public.worker_job set status = 'failed' where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('a claimed job without a lease', $sql$update public.worker_job set status = 'claimed' where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('a done job without evidence', $sql$update public.worker_job set status = 'done' where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('a fourth attempt', $sql$update public.worker_job set attempts = 4 where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('an unknown status', $sql$update public.worker_job set status = 'lost' where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('an unknown error code', $sql$update public.worker_job set status = 'failed', error_code = 'oops' where capture_id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('a replaced photo not erased', $sql$update public.capture set superseded_by = 'e4000000-0000-0000-0000-000000000012' where id = 'e4000000-0000-0000-0000-000000000011'$sql$),
    ('printed fields with a format', $sql$insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name) values ('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000011', 'ocr_server', 'TD1', '\x00', 'k')$sql$),
    ('server code lines without a format', $sql$insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name) values ('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000011', 'mrz_server', null, '\x00', 'k')$sql$),
    ('phone code lines without a format', $sql$insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name) values ('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000011', 'mrz_phone', null, '\x00', 'k')$sql$),
    ('an unknown source', $sql$insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name) values ('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000011', 'ocr_phone', null, '\x00', 'k')$sql$),
    ('a nonce that is not 32 hex characters', $sql$insert into public.worker_nonce (nonce, expires_at) values ('NOT-A-NONCE', now())$sql$),
    ('a public key that is not base64url', $sql$insert into public.worker_key (kid, public_key) values ('k2', 'not a key')$sql$)
  ) as t(label, statement) loop
    begin
      execute bad.statement;
      raise exception 'FAIL: % was stored', bad.label;
    exception when check_violation then
      raise notice 'ok: constraint refuses %', bad.label;
    end;
  end loop;
end $$;

-- Nonces ----------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.worker_use_nonce('m3-signer', '00112233445566778899aabbccddeeff', now() + interval '2 minutes'),
  'ok', 'nonce: a first use is accepted');
select pg_temp.assert_text(public.worker_use_nonce('m3-signer', '00112233445566778899aabbccddeeff', now() + interval '2 minutes'),
  'replayed', 'nonce: the same nonce again is refused');
select pg_temp.assert_text(public.worker_use_nonce('m3-revoked', 'ffeeddccbbaa99887766554433221100', now() + interval '2 minutes'),
  'revoked', 'nonce: a revoked key is refused');
select pg_temp.assert_text(public.worker_use_nonce('nobody', 'ffeeddccbbaa99887766554433221100', now() + interval '2 minutes'),
  'revoked', 'nonce: an unknown key is refused');
select pg_temp.assert_eq((select count(*) from public.worker_nonce), 1, 'nonce: refused requests record nothing');
commit;

-- The claim -------------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table m3_claim1 as select * from public.worker_claim();
select pg_temp.assert_eq((select count(*) from m3_claim1
    where job_id = pg_temp.job_of('e4000000-0000-0000-0000-000000000011') and attempt = 1
      and capture_id = 'e4000000-0000-0000-0000-000000000011' and kind = 'document_front'
      and declared_document = 'cni_biometric' and sha256 = 'm3-1-front-1' and byte_size = 20000
      and width = 1600 and height = 1009), 1,
  'claim: hands out the oldest waiting job with what the worker needs');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000011' and status = 'claimed' and attempts = 1
      and lease_until = now() + interval '120 seconds' and first_claimed_at = now()), 1,
  'claim: the job is leased for 120 s, its attempt counted, its start recorded');
select pg_temp.assert_eq((select count(*) from public.worker_claim() w where w.capture_id = 'e4000000-0000-0000-0000-000000000012'), 1,
  'claim: the next claim gets the next job');
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 0, 'claim: no row when nothing waits');
commit;

-- Sessions that may not run are given up on the way; a submitted test session runs.
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000041', 'e3000000-0000-0000-0000-000000000004', 'document_front', 'm3/4/front.jpg', 'm3-4-front', 'image/jpeg', 20000, 1600, 1131);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000051', 'e3000000-0000-0000-0000-000000000005', 'document_front', 'm3/5/front.jpg', 'm3-5-front', 'image/jpeg', 20000, 1600, 1131);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000031', 'e3000000-0000-0000-0000-000000000003', 'document_front', 'm3/3/front.jpg', 'm3-3-front', 'image/jpeg', 20000, 1600, 1131);
begin;
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim() w where w.capture_id = 'e4000000-0000-0000-0000-000000000031'), 1,
  'claim: a submitted test session runs');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id in ('e4000000-0000-0000-0000-000000000041', 'e4000000-0000-0000-0000-000000000051')
      and status = 'failed' and error_code = 'ineligible' and lease_until is null), 2,
  'claim: a session in review and an expired open session are given up as ineligible');
select pg_temp.assert_eq((select count(*) from public.audit_event
    where action = 'worker.job_failed' and actor_type = 'system' and actor_id is null and target_type = 'verification'
      and target_id in ('e3000000-0000-0000-0000-000000000004', 'e3000000-0000-0000-0000-000000000005')
      and details ->> 'code' = 'ineligible' and (details ->> 'attempts')::int = 0 and details ? 'jobId' and details ? 'captureId'), 2,
  'claim: each job given up is audited with its code');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000004') = '["server_unchecked"]'::jsonb
    and pg_temp.policy('e3000000-0000-0000-0000-000000000005') = '["server_unchecked"]'::jsonb,
  'claim: their cases are flagged server_unchecked');
commit;

-- The test-only switch is checked again at claim time.
begin;
update public.worker_settings set enabled_for_real_sessions = true;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000022', 'e3000000-0000-0000-0000-000000000002', 'document_front', 'm3/2/front-2.jpg', 'm3-2-front-2', 'image/jpeg', 20000, 1600, 1131);
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000022' and status = 'pending'), 1,
  'switch on: a real session''s photo waits for the worker');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000021' and status = 'failed' and error_code = 'ineligible'), 1,
  'switch on: the replaced photo''s finished job keeps its state');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000002') is null,
  'switch on: the replaced photo''s server_unchecked goes with it');
update public.worker_settings set enabled_for_real_sessions = false;
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 0, 'switch off again: the real session''s job is not handed out');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000022' and status = 'failed' and error_code = 'ineligible'), 1,
  'switch off again: it is given up as ineligible');
reset role;
update public.worker_settings set enabled_for_real_sessions = true;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000023', 'e3000000-0000-0000-0000-000000000002', 'document_front', 'm3/2/front-3.jpg', 'm3-2-front-3', 'image/jpeg', 20000, 1600, 1131);
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim() w where w.capture_id = 'e4000000-0000-0000-0000-000000000023'), 1,
  'switch on: a real session''s job is handed out');
rollback;

-- The daily cap.
begin;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000071', 'e3000000-0000-0000-0000-000000000007', 'document_front', 'm3/7/front.jpg', 'm3-7-front', 'image/jpeg', 20000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000072', 'e3000000-0000-0000-0000-000000000007', 'document_back', 'm3/7/back.jpg', 'm3-7-back', 'image/jpeg', 20000, 1600, 1009);
update public.worker_settings set daily_job_cap = (select count(*) from public.worker_job
  where first_claimed_at >= date_trunc('day', now() at time zone 'Africa/Douala') at time zone 'Africa/Douala');
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 0, 'cap: no job is started once the day''s cap is reached');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where verification_id = 'e3000000-0000-0000-0000-000000000007' and status = 'failed' and error_code = 'budget'), 2,
  'cap: waiting jobs are given up with code budget');
select pg_temp.assert_eq((select count(*) from public.audit_event
    where action = 'worker.job_failed' and target_id = 'e3000000-0000-0000-0000-000000000007' and details ->> 'code' = 'budget'), 2,
  'cap: and audited');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000007') = '["server_unchecked"]'::jsonb,
  'cap: the case is flagged server_unchecked');
reset role;
-- A job started today and retried after its lease expired is not held back by the cap.
update public.worker_job set lease_until = now() - interval '1 second' where capture_id = 'e4000000-0000-0000-0000-000000000011';
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim() w
    where w.capture_id = 'e4000000-0000-0000-0000-000000000011' and w.attempt = 2), 1,
  'cap: a retry of a job already started today still runs');
rollback;

-- Leases.
begin;
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 0, 'lease: a job under a live lease is not handed out again');
reset role;
update public.worker_job set lease_until = now() - interval '1 second' where capture_id = 'e4000000-0000-0000-0000-000000000011';
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim() w
    where w.capture_id = 'e4000000-0000-0000-0000-000000000011' and w.attempt = 2), 1,
  'lease: an expired lease is claimed again, as attempt 2');
reset role;
update public.worker_job set attempts = 3, lease_until = now() - interval '1 second' where capture_id = 'e4000000-0000-0000-0000-000000000011';
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 0, 'lease: after 3 attempts the job is not handed out');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000011' and status = 'failed' and error_code = 'attempts'), 1,
  'lease: it is given up with code attempts');
rollback;

-- The image lookup ------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000011'), 1) l
    where l.result = 'ok' and l.storage_path = 'm3/1/front-1.jpg' and l.capture_id = 'e4000000-0000-0000-0000-000000000011'
      and l.verification_id = 'e3000000-0000-0000-0000-000000000001' and l.byte_size = 20000), 1,
  'image: the lease holder gets the storage path');
select pg_temp.assert_text((select l.result from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000011'), 2) l),
  'not_found', 'image: another attempt gets nothing');
select pg_temp.assert_text((select l.result from public.worker_image_lookup('e9999999-0000-0000-0000-000000000000', 1) l),
  'not_found', 'image: an unknown job gets nothing');
select pg_temp.assert_text((select l.result from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000041'), 0) l),
  'not_found', 'image: a job that is not claimed gets nothing');
select pg_temp.assert_true((select l.storage_path is null from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000011'), 2) l),
  'image: a refusal carries no path');
commit;

-- The result ------------------------------------------------------------------------------------------
-- The front's snapshot is taken now; the back's result lands before the front's write.
create temp table m3_front_fp as select pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000011')) as fp;
grant select on m3_front_fp to service_role;

begin;
set local role service_role;
select pg_temp.assert_true((select s ->> 'verificationId' = 'e3000000-0000-0000-0000-000000000001'
      and s -> 'job' ->> 'status' = 'claimed' and (s -> 'job' ->> 'attempts')::int = 1 and s -> 'job' ->> 'kind' = 'document_back'
      and (s -> 'job' ->> 'captureLive')::boolean and s ->> 'declaredDocument' = 'cni_biometric'
      and jsonb_array_length(s -> 'sides') = 2 and s ->> 'fingerprint' ~ '^[0-9a-f]{32}$'
    from public.worker_case_snapshot(null, pg_temp.job_of('e4000000-0000-0000-0000-000000000012')) s),
  'snapshot: the job, the declared document, both sides and a fingerprint');
select pg_temp.assert_true(public.worker_case_snapshot(null, 'e9999999-0000-0000-0000-000000000000') is null
    and public.worker_case_snapshot('e9999999-0000-0000-0000-000000000000') is null,
  'snapshot: null for an unknown job or case');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000012'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000012')), pg_temp.capture_checks(true), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[]), pg_temp.td1(), 'TD1', pg_temp.fields()),
  'recorded', 'result: the back''s result is recorded');
select pg_temp.assert_true((select array_agg(check_name || ':' || check_version || ':' || outcome order by check_name)
    from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000012')
  = array['mrz_server:mrz-v1:pass', 'ocr_fields:server-checks-v1:pass', 'quality_server:server-checks-v1:pass'],
  'result: the per-photo checks, versioned');
select pg_temp.assert_text((select details ->> 'phone' from public.check_result
    where capture_id = 'e4000000-0000-0000-0000-000000000012' and check_name = 'mrz_server'),
  'missing', 'result: without the phone''s report, the comparison says missing');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data
    where capture_id = 'e4000000-0000-0000-0000-000000000012' and verification_id = 'e3000000-0000-0000-0000-000000000001'
      and ((source = 'mrz_server' and format = 'TD1') or (source = 'ocr_server' and format is null))
      and key_name = 'document_data_key_v1'), 2,
  'result: the code lines and the printed fields are stored, naming their key');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data edd
    where edd.capture_id = 'e4000000-0000-0000-0000-000000000012'
      and (position(convert_to(pg_temp.td1(), 'UTF8') in edd.ciphertext) > 0
        or position('ERIKSSON'::bytea in edd.ciphertext) > 0 or position('refugee'::bytea in edd.ciphertext) > 0
        or position('D23145890'::bytea in edd.ciphertext) > 0 or position('2025-03-01'::bytea in edd.ciphertext) > 0)), 0,
  'result: the ciphertexts contain none of the values');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data edd
    where edd.capture_id = 'e4000000-0000-0000-0000-000000000012' and get_byte(edd.ciphertext, 3) = 9), 2,
  'result: both are encrypted with AES-256');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000012' and status = 'done' and lease_until is null
      and error_code is null and evidence = pg_temp.evidence()), 1,
  'result: the job is done and keeps its evidence');
select pg_temp.assert_eq((select count(*) from public.check_result
    where verification_id = 'e3000000-0000-0000-0000-000000000001' and capture_id is null and check_name = 'classification'
      and check_version = 'server-checks-v1' and outcome = 'pass' and score = 1
      and details = pg_temp.case_checks(array[]::text[]) -> 'classification' -> 'details'), 1,
  'result: the case''s classification is written');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') = '["phone_report_missing"]'::jsonb,
  'result: the database adds phone_report_missing while the phone''s report has not arrived');
select pg_temp.assert_eq((select count(*) from public.audit_event
    where action = 'worker.result' and actor_type = 'system' and actor_id = 'm3-signer' and target_type = 'verification'
      and target_id = 'e3000000-0000-0000-0000-000000000001'
      and details = jsonb_build_object('jobId', pg_temp.job_of('e4000000-0000-0000-0000-000000000012'),
                                       'captureId', 'e4000000-0000-0000-0000-000000000012', 'attempt', 1,
                                       'checks', jsonb_build_object('quality_server', 'pass', 'ocr_fields', 'pass', 'mrz_server', 'pass'))), 1,
  'result: one audit entry with outcomes only');
commit;

reset role;
select pg_temp.assert_text((select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret)
    from public.extracted_document_data edd join vault.decrypted_secrets ds on ds.name = edd.key_name
    where edd.capture_id = 'e4000000-0000-0000-0000-000000000012' and edd.source = 'mrz_server'),
  pg_temp.td1(), 'result: the server''s lines decrypt with the Vault key');
select pg_temp.assert_text((select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret)
    from public.extracted_document_data edd join vault.decrypted_secrets ds on ds.name = edd.key_name
    where edd.capture_id = 'e4000000-0000-0000-0000-000000000012' and edd.source = 'ocr_server'),
  pg_temp.fields(), 'result: the printed fields decrypt with the Vault key');

-- Two photos finishing at the same moment: a write decided from an older snapshot is refused.
begin;
set local role service_role;
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000011'), 1,
    (select fp from m3_front_fp), pg_temp.capture_checks(false), '{"mrz": null, "expectedMrzFound": null, "expectedMrzValid": null, "keywordHits": {}, "qrPresent": false, "orientation": "portrait"}'::jsonb,
    pg_temp.case_checks(array['provisional_classification']), null, null, pg_temp.fields()),
  'stale', 'result: decided before the other side''s result landed -> stale');
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000011')
    + (select count(*) from public.extracted_document_data where capture_id = 'e4000000-0000-0000-0000-000000000011'), 0,
  'result: a stale write stores nothing');
select pg_temp.assert_text((select status from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000011'),
  'claimed', 'result: a stale write leaves the job claimed');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000011'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000011')), pg_temp.capture_checks(false),
    '{"mrz": null, "expectedMrzFound": null, "expectedMrzValid": null, "keywordHits": {}, "qrPresent": false, "orientation": "portrait"}'::jsonb,
    pg_temp.case_checks(array['provisional_classification', 'phone_report_missing', 'server_unchecked']), null, null,
    '{"surname":"ERIKSSON","issueDate":"2025-03-01"}'),
  'recorded', 'result: decided again from a fresh snapshot -> recorded');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') = '["phone_report_missing", "provisional_classification"]'::jsonb,
  'result: the function''s reasons plus the database''s, sorted; status reasons it sends are recomputed, not trusted');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data
    where capture_id = 'e4000000-0000-0000-0000-000000000011' and source = 'ocr_server'), 1,
  'result: no code lines stored for a side without them, the printed fields are');

-- The first result wins.
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000012'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000012')), pg_temp.capture_checks(true, false), pg_temp.evidence(),
    pg_temp.case_checks(array['mrz_unreadable_server']), null, null, null),
  'already_done', 'result: a second result for a job -> already_done');
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000012'), 3,
  'result: already_done changes nothing');
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'worker.result'
    and target_id = 'e3000000-0000-0000-0000-000000000001'), 2,
  'result: already_done and stale write no audit entry');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000012'), 2,
    'x', '[]'::jsonb, pg_temp.evidence(), null, null, null, null),
  'not_found', 'result: an attempt never handed out -> not_found');
select pg_temp.assert_text(public.worker_record_result('m3-signer', 'e9999999-0000-0000-0000-000000000000', 1,
    'x', '[]'::jsonb, pg_temp.evidence(), null, null, null, null),
  'not_found', 'result: an unknown job -> not_found');
commit;

-- The phone's report lands second: it is compared with the server's reading now.
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000012',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.phone_read('e4000000-0000-0000-0000-000000000012', true)),
  'ok', 'phone second: the report is recorded as in M2');
select pg_temp.assert_text((select details ->> 'phone' from public.check_result
    where capture_id = 'e4000000-0000-0000-0000-000000000012' and check_name = 'mrz_server'),
  'agrees', 'phone second: the same lines -> agrees');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') = '["provisional_classification"]'::jsonb,
  'phone second: phone_report_missing is gone, the function''s reasons stay');
commit;

-- Refusals: nothing is written, nothing is echoed.
begin;
set local role service_role;
do $$
declare
  bad record;
begin
  for bad in select * from (values
    ('TD1 lines as TD3', pg_temp.td1(), 'TD3', null::text),
    ('lower-case lines', lower(pg_temp.td1()), 'TD1', null),
    ('lines without a format', pg_temp.td1(), null, null),
    ('fields that are not JSON', null, null, 'surname=ERIKSSON'),
    ('fields that are a JSON array', null, null, '["ERIKSSON"]')
  ) as t(label, lines, format, fields) loop
    begin
      perform public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
        pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')), pg_temp.capture_checks(false), pg_temp.evidence(),
        pg_temp.case_checks(array[]::text[], 'passport'), bad.lines, bad.format, bad.fields);
      raise exception 'FAIL: result accepted %', bad.label;
    exception when invalid_parameter_value then
      if position('ERIKSSON' in sqlerrm) > 0 or position('<<' in sqlerrm) > 0 then
        raise exception 'FAIL: the error for % repeats the value', bad.label;
      end if;
    end;
  end loop;
  raise notice 'ok: result: lines of the wrong format and fields that are not a JSON object are refused, without echo';
end $$;
do $$ begin
  perform public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')),
    pg_temp.capture_checks(false) || '[{"name": "face_match", "version": "v0", "outcome": "pass", "details": {}}]'::jsonb,
    pg_temp.evidence(), pg_temp.case_checks(array[]::text[], 'passport'), null, null, pg_temp.fields());
  raise exception 'FAIL: an unknown per-photo check was stored';
exception when invalid_parameter_value then raise notice 'ok: result: an unknown per-photo check is refused';
end $$;
-- Supervisors and admins read check_result: keyword counts (a "republic" header tells a Cameroonian
-- passport from a foreign one) or any other extra key never reach the classification's details.
do $$
declare
  extra jsonb;
begin
  for extra in select * from jsonb_array_elements(
    '[{"keywordHits": {"republic": 2, "passport": 2}}, {"nationality": "UTO"}, {"subtype": "refugee"}]'::jsonb) loop
    begin
      perform public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
        pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')), pg_temp.capture_checks(false),
        pg_temp.evidence(),
        jsonb_set(pg_temp.case_checks(array[]::text[], 'passport'), '{classification,details}',
                  (pg_temp.case_checks(array[]::text[], 'passport') #> '{classification,details}') || extra),
        null, null, pg_temp.fields());
      raise exception 'FAIL: classification details with % were stored', extra;
    exception when invalid_parameter_value then
      if position('UTO' in sqlerrm) > 0 or position('refugee' in sqlerrm) > 0 then
        raise exception 'FAIL: the error repeats the value';
      end if;
    end;
  end loop;
  begin
    perform public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
      pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')), pg_temp.capture_checks(false),
      pg_temp.evidence(), jsonb_set(pg_temp.case_checks(array[]::text[], 'passport'), '{classification,details}', '"x"'),
      null, null, pg_temp.fields());
    raise exception 'FAIL: classification details that are not an object were stored';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'ok: result: classification details hold only the contract''s keys (no keyword counts, nothing else)';
end $$;
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000031')
    + (select count(*) from public.extracted_document_data where capture_id = 'e4000000-0000-0000-0000-000000000031'), 0,
  'result: a refused result writes nothing, not even part of it');
select pg_temp.assert_text((select status from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000031'),
  'claimed', 'result: a refused result leaves the job claimed');
commit;

-- Without the key, nothing is stored in plain text: the call fails.
begin;
delete from vault.secrets where name = 'document_data_key_v1';
set local role service_role;
do $$ begin
  perform public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')), pg_temp.capture_checks(false), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[], 'passport'), null, null, pg_temp.fields());
  raise exception 'FAIL: fields were recorded without the key';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: result: a missing key fails loudly';
end $$;
-- A result with nothing to encrypt needs no key.
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000031'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000031')), pg_temp.capture_checks(false), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[], 'passport'), null, null, null),
  'recorded', 'result: nothing to encrypt needs no key');
rollback;

-- The phone's report lands first ---------------------------------------------------------------------------
-- 6: the phone read other lines; 8: the phone read nothing; 9: the server read nothing.
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000062', 'e3000000-0000-0000-0000-000000000006', 'document_back', 'm3/6/back.jpg', 'm3-6-back', 'image/jpeg', 20000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000082', 'e3000000-0000-0000-0000-000000000008', 'document_back', 'm3/8/back.jpg', 'm3-8-back', 'image/jpeg', 20000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000092', 'e3000000-0000-0000-0000-000000000009', 'document_back', 'm3/9/back.jpg', 'm3-9-back', 'image/jpeg', 20000, 1600, 1009);
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('e3000000-0000-0000-0000-000000000006', 'e4000000-0000-0000-0000-000000000062',
    pg_temp.td1_bad(), 'TD1', 'flag', pg_temp.phone_read('e4000000-0000-0000-0000-000000000062', false)), 'ok',
  'phone first: a read report is recorded');
select pg_temp.assert_text(public.flow_record_mrz('e3000000-0000-0000-0000-000000000008', 'e4000000-0000-0000-0000-000000000082',
    null, null, 'flag', pg_temp.phone_unreadable('e4000000-0000-0000-0000-000000000082')), 'ok',
  'phone first: an unreadable report is recorded');
select pg_temp.assert_text(public.flow_record_mrz('e3000000-0000-0000-0000-000000000009', 'e4000000-0000-0000-0000-000000000092',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.phone_read('e4000000-0000-0000-0000-000000000092', true)), 'ok',
  'phone first: another read report is recorded');
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 1, 'phone first: claim 1');
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 1, 'phone first: claim 2');
select pg_temp.assert_eq((select count(*) from public.worker_claim()), 1, 'phone first: claim 3');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000062'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000062')), pg_temp.capture_checks(true), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[]), pg_temp.td1(), 'TD1', null), 'recorded', 'phone first: the server''s result is recorded');
select pg_temp.assert_text((select details ->> 'phone' from public.check_result
    where capture_id = 'e4000000-0000-0000-0000-000000000062' and check_name = 'mrz_server'),
  'differs', 'phone first: other lines -> differs');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000006') = '["mrz_disagreement"]'::jsonb,
  'phone first: the database adds mrz_disagreement');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000082'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000082')), pg_temp.capture_checks(true), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[]), pg_temp.td1(), 'TD1', null), 'recorded', 'phone first: recorded after an unreadable report');
select pg_temp.assert_text((select details ->> 'phone' from public.check_result
    where capture_id = 'e4000000-0000-0000-0000-000000000082' and check_name = 'mrz_server'),
  'unreadable', 'phone first: the phone read nothing -> unreadable');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000008') = '[]'::jsonb
    and (select outcome = 'pass' from public.check_result where verification_id = 'e3000000-0000-0000-0000-000000000008'
         and check_name = 'document_policy'),
  'phone first: no phone reason then; a policy without reasons passes');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000092'), 1,
    pg_temp.fp(pg_temp.job_of('e4000000-0000-0000-0000-000000000092')), pg_temp.capture_checks(true, false), pg_temp.evidence(),
    pg_temp.case_checks(array['mrz_unreadable_server']), null, null, null), 'recorded', 'server found nothing: recorded');
select pg_temp.assert_text((select details ->> 'phone' from public.check_result
    where capture_id = 'e4000000-0000-0000-0000-000000000092' and check_name = 'mrz_server'),
  'differs', 'server found nothing: the phone''s lines are not confirmed -> differs');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000009') = '["mrz_unreadable_server"]'::jsonb,
  'server found nothing: mrz_unreadable_server only, no disagreement over lines the server did not read');
commit;

-- A newer photo of a side replaces the older one -----------------------------------------------------------
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000013', 'e3000000-0000-0000-0000-000000000001', 'document_back', 'm3/1/back-2.jpg', 'm3-1-back-2', 'image/jpeg', 22000, 1600, 1009);
select pg_temp.assert_eq((select count(*) from public.capture
    where id = 'e4000000-0000-0000-0000-000000000012' and deleted_at is not null
      and superseded_by = 'e4000000-0000-0000-0000-000000000013'), 1,
  'replace: the older back is marked erased and replaced');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data where capture_id = 'e4000000-0000-0000-0000-000000000012'), 0,
  'replace: the data read from it (phone lines, server lines, printed fields) is deleted');
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000012'), 4,
  'replace: its check results stay, as history (no values in them)');
select pg_temp.assert_eq((select count(*) from public.capture
    where id = 'e4000000-0000-0000-0000-000000000011' and deleted_at is null and superseded_by is null), 1,
  'replace: the other side is untouched');
-- The trigger only marks the row: the file is removed by the M3 flow function. A photo replaced by a
-- plain insert, as the M2 flow makes while it still serves riders after this migration, keeps its file;
-- the deploy check lists it until it is removed through the Storage API.
insert into storage.objects (bucket_id, name) values
  ('id-captures', 'm3/1/front-1.jpg'), ('id-captures', 'm3/1/back-1.jpg'), ('id-captures', 'm3/1/back-2.jpg');
select pg_temp.assert_true((select array_agg(f.storage_path) from private.superseded_files_left() f) = array['m3/1/back-1.jpg'],
  'deploy check: the replaced photo whose file is still stored is listed, and only it');
delete from storage.objects where bucket_id = 'id-captures' and name = 'm3/1/back-1.jpg';
select pg_temp.assert_eq((select count(*) from private.superseded_files_left()), 0,
  'deploy check: empty once the file is removed');
select pg_temp.assert_text((select status from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000012'),
  'done', 'replace: a finished job keeps its state');
select pg_temp.assert_text((select status from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000013'),
  'pending', 'replace: the new photo gets a job');

begin;
set local role service_role;
select pg_temp.assert_text((select l.result from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000012'), 1) l),
  'gone', 'replace: the replaced photo''s image is gone');
select pg_temp.assert_true((select s -> 'sides' = jsonb_build_array(
      jsonb_build_object('kind', 'document_front', 'captureId', 'e4000000-0000-0000-0000-000000000011',
                         'evidence', '{"mrz": null, "expectedMrzFound": null, "expectedMrzValid": null, "keywordHits": {}, "qrPresent": false, "orientation": "portrait"}'::jsonb),
      jsonb_build_object('kind', 'document_back', 'captureId', 'e4000000-0000-0000-0000-000000000013', 'evidence', null))
    from public.worker_case_snapshot('e3000000-0000-0000-0000-000000000001') s),
  'replace: the case snapshot holds the newest photo of each side only');
-- The flow function decides the case again without the replaced photo.
select pg_temp.assert_text(public.worker_write_case('e3000000-0000-0000-0000-000000000001', 'stale-fingerprint', null),
  'stale', 'write case: an old fingerprint -> stale');
select pg_temp.assert_text(public.worker_write_case('e9999999-0000-0000-0000-000000000000', 'x', null),
  'not_found', 'write case: an unknown case -> not_found');
do $$ begin
  perform public.worker_write_case('e3000000-0000-0000-0000-000000000001', pg_temp.case_fp('e3000000-0000-0000-0000-000000000001'),
    jsonb_set(pg_temp.case_checks(array['provisional_classification']), '{classification,details,keywordHits}',
              '{"republic": 2}'::jsonb));
  raise exception 'FAIL: write case stored keyword counts';
exception when invalid_parameter_value then raise notice 'ok: write case: keyword counts never reach the classification''s details';
end $$;
select pg_temp.assert_text(public.worker_write_case('e3000000-0000-0000-0000-000000000001',
    pg_temp.case_fp('e3000000-0000-0000-0000-000000000001'), null), 'ok', 'write case: with no result left, the case checks are dropped');
select pg_temp.assert_eq((select count(*) from public.check_result where verification_id = 'e3000000-0000-0000-0000-000000000001'
    and capture_id is null), 0, 'write case: no classification and no policy without results or reasons');
select pg_temp.assert_text(public.worker_write_case('e3000000-0000-0000-0000-000000000001',
    pg_temp.case_fp('e3000000-0000-0000-0000-000000000001'), pg_temp.case_checks(array['provisional_classification'])), 'ok',
  'write case: decided from the front alone');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') = '["provisional_classification"]'::jsonb,
  'write case: the policy follows');
-- A job replaced while a worker holds it: its image and its result are gone.
select pg_temp.assert_eq((select count(*) from public.worker_claim() w where w.capture_id = 'e4000000-0000-0000-0000-000000000013'), 1,
  'replace: the new back is claimed');
reset role;
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('e4000000-0000-0000-0000-000000000014', 'e3000000-0000-0000-0000-000000000001', 'document_back', 'm3/1/back-3.jpg', 'm3-1-back-3', 'image/jpeg', 23000, 1600, 1009);
set local role service_role;
select pg_temp.assert_text((select status from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000013'),
  'superseded', 'replace: an unfinished job of the side is superseded');
select pg_temp.assert_text((select l.result from public.worker_image_lookup(pg_temp.job_of('e4000000-0000-0000-0000-000000000013'), 1) l),
  'gone', 'replace: its image is gone');
select pg_temp.assert_text(public.worker_record_result('m3-signer', pg_temp.job_of('e4000000-0000-0000-0000-000000000013'), 1,
    'any', pg_temp.capture_checks(true), pg_temp.evidence(), pg_temp.case_checks(array[]::text[]), pg_temp.td1(), 'TD1', null),
  'gone', 'replace: its late result is gone, not recorded');
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'e4000000-0000-0000-0000-000000000013'), 0,
  'replace: nothing was written for it');
commit;

-- GET /flow/checks' rows ---------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table m3_state as select * from public.flow_check_state('e3000000-0000-0000-0000-000000000001');
select pg_temp.assert_true((select array_agg(capture_id::text || ':' || live || ':' || coalesce(job_status, '-') || ':'
      || coalesce(quality_verdict, '-') || ':' || coalesce(phone_mrz_pass::text, '-') || ':' || ring_failed order by created_at, capture_id)
    from m3_state)
  = array[
    'e4000000-0000-0000-0000-000000000011:true:done:ok:-:false',
    'e4000000-0000-0000-0000-000000000012:false:done:ok:true:false',
    'e4000000-0000-0000-0000-000000000018:false:-:-:-:false',
    'e4000000-0000-0000-0000-000000000013:false:superseded:-:-:false',
    'e4000000-0000-0000-0000-000000000014:true:pending:-:-:false'],
  'check state: every document photo with its job, verdict and the phone''s read, never the selfie');
reset role;
update public.worker_job set ring_failed_at = now() where capture_id = 'e4000000-0000-0000-0000-000000000014';
set local role service_role;
select pg_temp.assert_true((select ring_failed from public.flow_check_state('e3000000-0000-0000-0000-000000000001')
    where capture_id = 'e4000000-0000-0000-0000-000000000014'), 'check state: a failed ring is reported');
rollback;

-- The sweep ----------------------------------------------------------------------------------------------
begin;
update public.worker_job set status = 'claimed', attempts = 1, lease_until = now() - interval '1 second'
 where capture_id = 'e4000000-0000-0000-0000-000000000014';
select pg_temp.assert_true(private.worker_sweep() = '{"requeued": 1, "failed": 0, "rung": true, "noncesPurged": 0}'::jsonb,
  'sweep: requeues an expired lease and rings');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000014' and status = 'pending' and lease_until is null and attempts = 1), 1,
  'sweep: the job waits again, its attempts kept');
select pg_temp.assert_eq((select count(*) from net.stub_http_post_calls
    where url = 'https://confiance-verify-worker.vercel.app/api/process' and body = '{}'::jsonb
      and headers = '{"Content-Type": "application/json"}'::jsonb and timeout_milliseconds = 60000), 1,
  'sweep: one ring, to the Vault URL, with an explicit timeout');
rollback;

begin;
update public.worker_job set status = 'claimed', attempts = 3, lease_until = now() - interval '1 second'
 where capture_id = 'e4000000-0000-0000-0000-000000000014';
select pg_temp.assert_true(private.worker_sweep() @> '{"requeued": 0, "failed": 1, "rung": false}'::jsonb,
  'sweep: gives up after 3 attempts (and rings only while a job waits)');
select pg_temp.assert_eq((select count(*) from public.worker_job
    where capture_id = 'e4000000-0000-0000-0000-000000000014' and status = 'failed' and error_code = 'attempts'), 1,
  'sweep: the job is failed with code attempts');
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'worker.job_failed'
    and target_id = 'e3000000-0000-0000-0000-000000000001' and details ->> 'code' = 'attempts' and (details ->> 'attempts')::int = 3), 1,
  'sweep: and audited');
select pg_temp.assert_true(pg_temp.policy('e3000000-0000-0000-0000-000000000001') = '["provisional_classification", "server_unchecked"]'::jsonb,
  'sweep: the case gets server_unchecked, the function''s reasons stay');
select pg_temp.assert_eq((select count(*) from net.stub_http_post_calls), 0, 'sweep: no ring when nothing waits');
rollback;

begin;
update public.worker_job set created_at = now() - interval '61 minutes' where capture_id = 'e4000000-0000-0000-0000-000000000014';
select pg_temp.assert_true(private.worker_sweep() @> '{"failed": 1}'::jsonb, 'sweep: gives up on a job waiting over an hour');
select pg_temp.assert_text((select error_code from public.worker_job where capture_id = 'e4000000-0000-0000-0000-000000000014'),
  'expired', 'sweep: with code expired');
rollback;

begin;
delete from vault.secrets where name = 'worker_ring_url';
select pg_temp.assert_true(private.worker_sweep() @> '{"rung": false}'::jsonb, 'sweep: no ring without a URL in Vault');
select pg_temp.assert_eq((select count(*) from net.stub_http_post_calls), 0, 'sweep: nothing sent');
rollback;

begin;
insert into public.worker_nonce (nonce, expires_at) values
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '1 second'),
  ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', now() + interval '1 minute');
insert into cron.job_run_details (jobid, status, start_time, end_time) values
  (1, 'succeeded', now() - interval '8 days', now() - interval '8 days'),
  (1, 'succeeded', now() - interval '1 day', now() - interval '1 day');
select pg_temp.assert_true(private.worker_sweep() @> '{"noncesPurged": 1}'::jsonb, 'sweep: purges expired nonces');
select pg_temp.assert_true((select array_agg(nonce order by nonce) from public.worker_nonce where nonce ~ '^(a|b)+$')
  = array['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], 'sweep: keeps nonces still in their window');
select pg_temp.assert_eq((select count(*) from cron.job_run_details where end_time < now() - interval '7 days'), 0,
  'sweep: purges cron logs over a week old');
select pg_temp.assert_eq((select count(*) from cron.job_run_details), 1, 'sweep: keeps the recent ones');
rollback;

-- Staff: the data read, every source, live photos only ------------------------------------------------------
begin;
set local role service_role;
create temp table m3_read as
  select * from public.staff_read_document_data('e3000000-0000-0000-0000-000000000006', 'e1000000-0000-0000-0000-000000000001', 'supervisor');
select pg_temp.assert_true((select array_agg(source || ':' || coalesce(format, '-') order by source) from m3_read)
  = array['mrz_phone:TD1', 'mrz_server:TD1'], 'read: the phone''s and the server''s code lines');
select pg_temp.assert_text((select lines from m3_read where source = 'mrz_server'), pg_temp.td1(), 'read: the server''s lines');
select pg_temp.assert_text((select lines from m3_read where source = 'mrz_phone'), pg_temp.td1_bad(), 'read: the phone''s lines');
select pg_temp.assert_true((select bool_and(fields is null) from m3_read), 'read: code lines have no fields');
create temp table m3_read1 as
  select * from public.staff_read_document_data('e3000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'supervisor');
select pg_temp.assert_eq((select count(*) from m3_read1), 1, 'read: only live photos'' data (the replaced back''s is gone)');
select pg_temp.assert_true((select source = 'ocr_server' and format is null and lines is null
      and fields = '{"surname": "ERIKSSON", "issueDate": "2025-03-01"}'::jsonb and capture_id = 'e4000000-0000-0000-0000-000000000011'
    from m3_read1), 'read: printed fields come back as a JSON object');
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'document_data.view'
    and target_id = 'e3000000-0000-0000-0000-000000000001' and details = '{"role": "supervisor", "items": 1}'::jsonb), 1,
  'read: the audit entry counts the rows returned');
commit;
-- A photo erased later (retention) takes its data out of the read, even before its rows are deleted.
begin;
update public.capture set deleted_at = now() where id = 'e4000000-0000-0000-0000-000000000011';
set local role service_role;
select pg_temp.assert_eq((select count(*) from public.staff_read_document_data('e3000000-0000-0000-0000-000000000001',
    'e1000000-0000-0000-0000-000000000001', 'supervisor')), 0, 'read: an erased photo''s data is not returned');
rollback;

-- Who sees what -----------------------------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.check_result
    where verification_id = 'e3000000-0000-0000-0000-000000000001' and check_name in ('classification', 'document_policy', 'quality_server', 'mrz_server', 'ocr_fields')), 7,
  'a supervisor reads the server checks of a case (3 + 2 per photo, 2 for the case)');
reset role;
create temp table expected_jobs on commit drop as
  select capture_id, status from public.worker_job where verification_id = 'e3000000-0000-0000-0000-000000000001';
grant select on expected_jobs to authenticated;
set local role authenticated;
select pg_temp.assert_true((select count(*) from expected_jobs) > 0
    and not exists (select capture_id, status from public.worker_job where verification_id = 'e3000000-0000-0000-0000-000000000001'
                    except select * from expected_jobs)
    and not exists (select * from expected_jobs
                    except select capture_id, status from public.worker_job where verification_id = 'e3000000-0000-0000-0000-000000000001'),
  'a supervisor reads the status of each photo''s job in a case');
do $$ begin
  perform evidence from public.worker_job;
  raise exception 'FAIL: a supervisor read the jobs'' evidence';
exception when insufficient_privilege then raise notice 'ok: a supervisor cannot read the jobs'' evidence';
end $$;
do $$ begin
  perform error_code, attempts from public.worker_job;
  raise exception 'FAIL: a supervisor read the jobs'' error codes';
exception when insufficient_privilege then raise notice 'ok: nor their error codes and attempts';
end $$;
do $$ begin
  update public.worker_job set status = 'done' where verification_id = 'e3000000-0000-0000-0000-000000000001';
  raise exception 'FAIL: a supervisor changed a job';
exception when insufficient_privilege then raise notice 'ok: nor change a job';
end $$;
set local request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.check_result where verification_id = 'e3000000-0000-0000-0000-000000000001'), 0,
  'a reviewer not assigned sees none of them');
select pg_temp.assert_eq((select count(*) from public.worker_job where verification_id = 'e3000000-0000-0000-0000-000000000001'), 0,
  'nor the status of its jobs');
rollback;

-- Nothing read from the document in check details or the audit log ------------------------------------------
select pg_temp.assert_eq((select count(*) from public.check_result cr
    where cr.check_name in ('quality_server', 'mrz_server', 'ocr_fields', 'classification', 'document_policy')
      and (cr.details::text like '%ERIKSSON%' or cr.details::text like '%D2314589%' or cr.details::text like '%7408122%'
        or cr.details::text like '%<<%' or cr.details::text like '%refugee%' or cr.details::text like '%2025-03-01%'
        or cr.details::text like '%UTO%')), 0,
  'privacy: no value read from a document in the server checks');
select pg_temp.assert_eq((select count(*) from public.audit_event ae
    where (ae.action like 'worker.%' or ae.action in ('mrz.record', 'document_data.view'))
      and (row_to_json(ae)::text like '%ERIKSSON%' or row_to_json(ae)::text like '%D2314589%' or row_to_json(ae)::text like '%<<%'
        or row_to_json(ae)::text like '%refugee%' or row_to_json(ae)::text like '%2025-03-01%')), 0,
  'privacy: none in the audit log either');

-- RPC privileges ---------------------------------------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('worker_claim', 'worker_case_snapshot', 'worker_record_result', 'worker_write_case',
                        'flow_record_mrz', 'staff_read_document_data')
      and p.prosecdef and p.proconfig = array['search_path=""']), 6,
  'the RPCs that need Vault or the private helpers are SECURITY DEFINER with an empty search_path');
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('worker_use_nonce', 'worker_image_lookup', 'flow_check_state')
      and not p.prosecdef and p.proconfig = array['search_path=""']), 3,
  'the other M3 RPCs run as the caller, with an empty search_path');
do $$
declare
  fn text;
  role_name text;
begin
  foreach fn in array array[
    'public.worker_use_nonce(text, text, timestamptz)', 'public.worker_claim()', 'public.worker_image_lookup(uuid, integer)',
    'public.worker_case_snapshot(uuid, uuid)', 'public.worker_record_result(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text)',
    'public.worker_write_case(uuid, text, jsonb)', 'public.flow_check_state(uuid)'] loop
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'FAIL: the service role cannot execute %', fn;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(role_name, fn, 'execute') then
        raise exception 'FAIL: % can execute %', role_name, fn;
      end if;
    end loop;
  end loop;
  foreach fn in array array[
    'private.worker_sweep()', 'private.worker_fail_job(uuid, text)', 'private.worker_apply_case(uuid, jsonb)',
    'private.worker_refresh_policy(uuid, text[], text)', 'private.mrz_phone_agreement(uuid, text)',
    'private.worker_case_inputs(uuid)', 'private.worker_status_reasons(uuid)', 'private.worker_lock_case(uuid)',
    'private.superseded_files_left()'] loop
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(role_name, fn, 'execute') then
        raise exception 'FAIL: % can execute %', role_name, fn;
      end if;
    end loop;
  end loop;
  raise notice 'ok: the M3 RPCs are for the service role only; the private helpers for nobody';
end $$;

begin;
set local role anon;
do $$ begin
  perform * from public.worker_claim();
  raise exception 'FAIL: anon claimed a job';
exception when insufficient_privilege then raise notice 'ok: anon cannot claim a job';
end $$;
rollback;
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';
do $$ begin
  perform private.worker_sweep();
  raise exception 'FAIL: signed-in staff ran the sweep';
exception when insufficient_privilege then raise notice 'ok: signed-in staff cannot run the sweep';
end $$;
rollback;

-- Order of a case's audit entries, and the chain ----------------------------------------------------------------
select pg_temp.assert_true((select array_agg(action order by id) from public.audit_event
    where target_id = 'e3000000-0000-0000-0000-000000000001')
  = array['worker.result', 'worker.result', 'mrz.record', 'document_data.view'],
  'audit: the case''s entries are in order (two results, the phone''s report, a staff view)');
select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after M3');
