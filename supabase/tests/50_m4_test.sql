-- M4 tests: the values worker_case_snapshot decrypts for the consistency checks (newest live photos
-- only, never the card sub-type, service role only, a missing key fails loudly), and the case-level
-- `consistency` check (written, replaced, dropped; unknown keys and codes refused; its flags kept as
-- document_policy reasons; nothing read from a document in check_result or audit_event). Run by
-- scripts/test-db.sh after 40_m3_test.sql in the same database; the ids used here (f...) do not overlap
-- with the earlier files' fixtures. Any failed assertion aborts.
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

-- ICAO Doc 9303 TD1 specimen (fictitious state "UTO"; expired in 2012), as the functions send lines.
create function pg_temp.td1() returns text language sql immutable as $$
  select E'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
$$;
-- Printed fields as the worker function stores them (WorkerFields, sub-type included).
create function pg_temp.fields() returns text language sql immutable as $$
  select '{"surname":"ERIKSSON","givenNames":"ANNA MARIA","documentNumber":"D23145890","birthDate":"1974-08-12","issueDate":"2002-04-16","subtype":"refugee"}'
$$;

create function pg_temp.capture_checks() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('name', 'quality_server', 'version', 'server-checks-v1', 'outcome', 'pass', 'details',
      jsonb_build_object('verdict', 'ok', 'provisional', true, 'engine', 'worker-2/test',
        'quality', jsonb_build_object('sharpness', 40, 'glareRatio', 0.001, 'meanLuma', 140, 'documentFound', true,
                                      'documentConfidence', 0.9, 'longSide', 1600, 'textLines', 12),
        'timing', jsonb_build_object('ms', 2100, 'cold', false))))
$$;

create function pg_temp.evidence() returns jsonb language sql immutable as $$
  select '{"mrz": {"family": "residence_permit", "valid": true}, "expectedMrzFound": true, "expectedMrzValid": true, "keywordHits": {}, "qrPresent": false, "orientation": null}'::jsonb
$$;

-- The case-level checks as the worker function decides them since M4.
create function pg_temp.case_checks(flags text[], details jsonb default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'version', 'server-checks-v1',
    'classification', jsonb_build_object('outcome', 'flag', 'score', 1, 'details', jsonb_build_object(
      'detected', 'residence_permit', 'basis', 'mrz', 'provisional', false, 'matchesDeclared', true, 'confidence', 1,
      'qrPresent', false)),
    'reasons', to_jsonb(array['manual_review_document'] || flags),
    'consistency', jsonb_build_object(
      'outcome', case when cardinality(flags) > 0 then 'flag' else 'pass' end,
      'details', coalesce(details, jsonb_build_object('flags', to_jsonb(flags), 'provisional', '[]'::jsonb,
                                                      'basis', 'mrz', 'mismatches', '[]'::jsonb))))
$$;

create function pg_temp.job_of(capture uuid) returns uuid language sql stable as $$
  select j.id from public.worker_job j where j.capture_id = capture
$$;
create function pg_temp.case_fp(verification uuid) returns text language sql stable as $$
  select public.worker_case_snapshot(verification) ->> 'fingerprint'
$$;
create function pg_temp.data_of(verification uuid) returns jsonb language sql stable as $$
  select public.worker_case_snapshot(verification) -> 'documentData'
$$;
create function pg_temp.consistency(verification uuid) returns public.check_result language sql stable as $$
  select * from public.check_result cr
  where cr.verification_id = verification and cr.capture_id is null and cr.check_name = 'consistency'
$$;
create function pg_temp.policy(verification uuid) returns jsonb language sql stable as $$
  select cr.details -> 'reasons' from public.check_result cr
  where cr.verification_id = verification and cr.capture_id is null and cr.check_name = 'document_policy'
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.td1() to service_role;
grant execute on function pg_temp.fields() to service_role;
grant execute on function pg_temp.capture_checks() to service_role;
grant execute on function pg_temp.evidence() to service_role;
grant execute on function pg_temp.case_checks(text[], jsonb) to service_role;
grant execute on function pg_temp.job_of(uuid) to service_role;
grant execute on function pg_temp.case_fp(uuid) to service_role;
grant execute on function pg_temp.data_of(uuid) to service_role;
grant execute on function pg_temp.consistency(uuid) to service_role;
grant execute on function pg_temp.policy(uuid) to service_role;

-- Fixtures (as superuser) ----------------------------------------------------------------------------
insert into auth.users (id, email) values ('f1000000-0000-0000-0000-000000000001', 'supervisor@m4.test');
insert into public.staff_profile (user_id, role, full_name, active)
  values ('f1000000-0000-0000-0000-000000000001', 'supervisor', 'M4 Supervisor', true);
insert into public.api_client (id, name, api_key_hash) values ('f0000000-0000-0000-0000-000000000001', 'm4-test-client', 'disabled:m4');
insert into public.applicant (id, api_client_id, external_user_id)
  values ('f2000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'm4-rider-1');
insert into public.worker_key (kid, public_key) values ('m4-signer', 'A1qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
-- A test session with a residence permit (code lines on the back).
insert into public.verification (id, applicant_id, attempt_no, status, declared_document, is_test, session_expires_at) values
  ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 1, 'in_progress', 'residence_permit', true, now() + interval '1 hour');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('f4000000-0000-0000-0000-000000000011', 'f3000000-0000-0000-0000-000000000001', 'document_front', 'm4/1/front-1.jpg', 'm4-1-front-1', 'image/jpeg', 20000, 1600, 1009);
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('f4000000-0000-0000-0000-000000000012', 'f3000000-0000-0000-0000-000000000001', 'document_back', 'm4/1/back-1.jpg', 'm4-1-back-1', 'image/jpeg', 21000, 1600, 1009);
-- Both jobs handed out (as worker_claim would; the earlier files may have left other jobs waiting).
update public.worker_job set status = 'claimed', attempts = 1, lease_until = now() + interval '120 seconds',
       first_claimed_at = now()
 where verification_id = 'f3000000-0000-0000-0000-000000000001';

-- Before any result -------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_true(pg_temp.data_of('f3000000-0000-0000-0000-000000000001') = '[]'::jsonb,
  'snapshot: no data read yet, an empty documentData');
commit;

-- Results: the front's printed fields, the back's code lines --------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.worker_record_result('m4-signer', pg_temp.job_of('f4000000-0000-0000-0000-000000000011'), 1,
    pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'), pg_temp.capture_checks(), pg_temp.evidence(),
    pg_temp.case_checks(array[]::text[]), null, null, pg_temp.fields()),
  'recorded', 'result: the front''s result is recorded with a consistency check');
select pg_temp.assert_text(public.worker_record_result('m4-signer', pg_temp.job_of('f4000000-0000-0000-0000-000000000012'), 1,
    pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'), pg_temp.capture_checks(), pg_temp.evidence(),
    pg_temp.case_checks(array['document_expired', 'mrz_print_mismatch'],
      '{"flags": ["document_expired", "mrz_print_mismatch"], "provisional": ["number_format"], "basis": "mrz", "mismatches": ["name"]}'::jsonb),
    pg_temp.td1(), 'TD1', '{"issueDate":"2002-04-16"}'),
  'recorded', 'result: the back''s result is recorded with its flags');

create temp table m4_data as select pg_temp.data_of('f3000000-0000-0000-0000-000000000001') as data;
select pg_temp.assert_eq((select jsonb_array_length(data) from m4_data), 2,
  'snapshot: documentData holds both photos');
select pg_temp.assert_true((select data -> 1 ->> 'kind' = 'document_back' and data -> 1 ->> 'mrzLines' = pg_temp.td1()
    and data -> 1 -> 'fields' = '{"issueDate": "2002-04-16"}'::jsonb
    and data -> 1 ->> 'captureId' = 'f4000000-0000-0000-0000-000000000012' from m4_data),
  'snapshot: the back''s code lines and fields, decrypted');
select pg_temp.assert_true((select data -> 0 ->> 'kind' = 'document_front' and data -> 0 -> 'mrzLines' = 'null'::jsonb
    and data -> 0 -> 'fields' ->> 'surname' = 'ERIKSSON' and data -> 0 -> 'fields' ->> 'birthDate' = '1974-08-12' from m4_data),
  'snapshot: the front''s printed fields, decrypted, no code lines');
select pg_temp.assert_true((select not (data::text like '%subtype%') and not (data::text like '%refugee%') from m4_data),
  'snapshot: never the card sub-type');
select pg_temp.assert_true((select array_agg(k order by k) from jsonb_object_keys(public.worker_case_snapshot('f3000000-0000-0000-0000-000000000001')) k)
    = array['declaredDocument', 'documentData', 'fingerprint', 'job', 'sides', 'verificationId'],
  'snapshot: documentData beside the M3 keys');
commit;

select pg_temp.assert_true((select outcome = 'flag' and check_version = 'server-checks-v1' and score is null
      and details = '{"flags": ["document_expired", "mrz_print_mismatch"], "provisional": ["number_format"], "basis": "mrz", "mismatches": ["name"]}'::jsonb
    from pg_temp.consistency('f3000000-0000-0000-0000-000000000001')),
  'consistency: the check is stored with its codes and outcome');
select pg_temp.assert_eq((select count(*) from public.check_result where verification_id = 'f3000000-0000-0000-0000-000000000001'
    and capture_id is null and check_name = 'consistency'), 1,
  'consistency: one per case (the second result replaced the first)');
select pg_temp.assert_true(pg_temp.policy('f3000000-0000-0000-0000-000000000001')
    = '["document_expired", "manual_review_document", "mrz_print_mismatch"]'::jsonb,
  'consistency: its flags are document_policy reasons, with the others, sorted');

-- Staff read it like the other checks ----------------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000001';
select pg_temp.assert_eq((select count(*) from public.check_result
    where verification_id = 'f3000000-0000-0000-0000-000000000001' and check_name = 'consistency'), 1,
  'staff: a supervisor reads the consistency check');
rollback;
begin;
set local role anon;
do $$ begin
  perform 1 from public.check_result where check_name = 'consistency';
  raise exception 'FAIL: anon read check_result';
exception when insufficient_privilege then raise notice 'ok: anon reads no consistency check';
end $$;
rollback;

-- Refused details ----------------------------------------------------------------------------------------------
do $$
declare
  bad record;
begin
  for bad in select * from (values
    ('a value read from the document', '{"flags": [], "provisional": [], "basis": "mrz", "mismatches": [], "surname": "ERIKSSON"}'),
    ('an unknown flag', '{"flags": ["looks_fake"], "provisional": [], "basis": "mrz", "mismatches": []}'),
    ('an unknown provisional code', '{"flags": [], "provisional": ["D23145890"], "basis": "mrz", "mismatches": []}'),
    ('an unknown mismatch kind', '{"flags": ["mrz_print_mismatch"], "provisional": [], "basis": "mrz", "mismatches": ["ERIKSSON"]}'),
    ('a code that is not a string', '{"flags": [{"code": "under_18"}], "provisional": [], "basis": "mrz", "mismatches": []}'),
    ('an unknown basis', '{"flags": [], "provisional": [], "basis": "guess", "mismatches": []}'),
    ('a missing list', '{"flags": [], "basis": "mrz", "mismatches": []}'),
    ('details that are not an object', '"document_expired"')
  ) as t(label, details) loop
    begin
      perform public.worker_write_case('f3000000-0000-0000-0000-000000000001', pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'),
        pg_temp.case_checks(array[]::text[], bad.details::jsonb));
      raise exception 'FAIL: consistency details with % were stored', bad.label;
    exception when invalid_parameter_value then
      raise notice 'ok: consistency refuses %', bad.label;
    end;
  end loop;
  begin
    perform public.worker_write_case('f3000000-0000-0000-0000-000000000001', pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'),
      pg_temp.case_checks(array[]::text[]) || '{"consistency": {"outcome": "fail", "details": {"flags": [], "provisional": [], "basis": "none", "mismatches": []}}}'::jsonb);
    raise exception 'FAIL: a consistency outcome of fail was stored';
  exception when invalid_parameter_value then
    raise notice 'ok: consistency refuses an outcome other than pass, flag or skipped';
  end;
end $$;
select pg_temp.assert_true((select details ->> 'basis' = 'mrz' from pg_temp.consistency('f3000000-0000-0000-0000-000000000001')),
  'consistency: a refused write changes nothing');

-- Rewritten, then dropped ------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.assert_text(public.worker_write_case('f3000000-0000-0000-0000-000000000001', pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'),
    pg_temp.case_checks(array[]::text[], '{"flags": [], "provisional": [], "basis": "printed", "mismatches": []}'::jsonb)),
  'ok', 'consistency: rewritten without flags');
commit;
select pg_temp.assert_true((select outcome = 'pass' and details ->> 'basis' = 'printed' from pg_temp.consistency('f3000000-0000-0000-0000-000000000001'))
    and pg_temp.policy('f3000000-0000-0000-0000-000000000001') = '["manual_review_document"]'::jsonb,
  'consistency: its flags leave the reasons with it');
begin;
set local role service_role;
select pg_temp.assert_text(public.worker_write_case('f3000000-0000-0000-0000-000000000001', pg_temp.case_fp('f3000000-0000-0000-0000-000000000001'),
    pg_temp.case_checks(array[]::text[]) - 'consistency'),
  'ok', 'consistency: a payload without it (an M3 function) is written');
commit;
select pg_temp.assert_true(pg_temp.consistency('f3000000-0000-0000-0000-000000000001') is null,
  'consistency: ... and the check is dropped');

-- A replaced photo's values are gone from the snapshot ------------------------------------------------------------
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height)
  values ('f4000000-0000-0000-0000-000000000013', 'f3000000-0000-0000-0000-000000000001', 'document_back', 'm4/1/back-2.jpg', 'm4-1-back-2', 'image/jpeg', 21000, 1600, 1009);
begin;
set local role service_role;
select pg_temp.assert_true((select jsonb_agg(d ->> 'captureId') from jsonb_array_elements(pg_temp.data_of('f3000000-0000-0000-0000-000000000001')) d)
    = '["f4000000-0000-0000-0000-000000000011"]'::jsonb,
  'snapshot: a replaced photo''s values are gone, the newer photo has none yet');
commit;

-- A missing key fails loudly --------------------------------------------------------------------------------------------
begin;
insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
  values ('f3000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000013', 'mrz_server', 'TD1', '\x00', 'document_data_key_gone');
set local role service_role;
do $$ begin
  perform public.worker_case_snapshot('f3000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: a snapshot was taken without the key of a row';
exception when raise_exception then
  if sqlerrm not like 'worker_case_document_data: a document data key is missing%' then raise; end if;
  raise notice 'ok: snapshot: a row whose key is missing from Vault fails loudly';
end $$;
rollback;

-- Privileges ---------------------------------------------------------------------------------------------------------------
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(role_name, 'private.worker_case_document_data(uuid)', 'execute') then
      raise exception 'FAIL: % can execute private.worker_case_document_data', role_name;
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(role_name, 'public.worker_case_snapshot(uuid, uuid)', 'execute') then
      raise exception 'FAIL: % can execute public.worker_case_snapshot', role_name;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.worker_case_snapshot(uuid, uuid)', 'execute') then
    raise exception 'FAIL: the service role cannot take a snapshot';
  end if;
  raise notice 'ok: the decrypting helper is for nobody; the snapshot for the service role only';
end $$;
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'worker_case_snapshot' and p.prosecdef and p.proconfig = array['search_path=""']), 1,
  'the snapshot is still SECURITY DEFINER with an empty search_path');
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'worker_case_document_data' and not p.prosecdef and p.proconfig = array['search_path=""']), 1,
  'the helper runs as its caller, with an empty search_path');
select pg_temp.assert_true(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.proname in ('worker_case_snapshot', 'worker_apply_case', 'worker_case_document_data')
    group by p.proname having count(*) > 1),
  'no second overload of a replaced function');

-- Privacy ------------------------------------------------------------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from public.check_result cr
    where cr.verification_id = 'f3000000-0000-0000-0000-000000000001'
      and (cr.details::text like '%ERIKSSON%' or cr.details::text like '%D2314589%' or cr.details::text like '%7408122%'
        or cr.details::text like '%1974%' or cr.details::text like '%2002-04-16%' or cr.details::text like '%<<%'
        or cr.details::text like '%refugee%' or cr.details::text like '%UTO%')), 0,
  'privacy: no value read from a document in the checks, consistency included');
select pg_temp.assert_eq((select count(*) from public.audit_event ae
    where ae.target_id = 'f3000000-0000-0000-0000-000000000001'
      and (row_to_json(ae)::text like '%ERIKSSON%' or row_to_json(ae)::text like '%D2314589%' or row_to_json(ae)::text like '%<<%'
        or row_to_json(ae)::text like '%1974%' or row_to_json(ae)::text like '%refugee%' or row_to_json(ae)::text like '%document_expired%')), 0,
  'privacy: none in the audit log, and no consistency code there either');
select pg_temp.assert_true((select array_agg(action order by id) from public.audit_event
    where target_id = 'f3000000-0000-0000-0000-000000000001') = array['worker.result', 'worker.result'],
  'audit: taking snapshots (which decrypt) writes nothing; only the two results are audited');
select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after M4');

-- Names the code relies on ---------------------------------------------------------------------------------------------------
-- contract.ts SERVER_CHECK_NAMES.consistency, CONSISTENCY_FLAGS and MISMATCH_KINDS: the same codes as the database accepts.
select pg_temp.assert_true(position('''consistency''' in pg_get_functiondef('private.worker_apply_case(uuid, jsonb)'::regprocedure)) > 0
    and position('''document_expired'', ''under_18'', ''mrz_print_mismatch'', ''date_logic'', ''number_format''' in
                 pg_get_functiondef('private.worker_apply_case(uuid, jsonb)'::regprocedure)) > 0
    and position('''name'', ''number'', ''birth_date'', ''expiry_date''' in
                 pg_get_functiondef('private.worker_apply_case(uuid, jsonb)'::regprocedure)) > 0,
  'the database accepts the contract''s consistency codes, in its order');
