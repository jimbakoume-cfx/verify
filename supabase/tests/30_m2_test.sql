-- M2 tests: the CNI split, the encrypted document data, the MRZ check result and the two RPCs
-- (flow_record_mrz, staff_read_document_data). Run by scripts/test-db.sh after 20_m1_test.sql in the
-- same database; the ids used here (d...) do not overlap with the earlier files' fixtures.
-- Any failed assertion aborts with an error.
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

-- ICAO Doc 9303 specimens (fictitious state "UTO"), as the flow function sends them: the lines
-- joined with a newline. td1_bad has a wrong document number check digit (7 -> 8).
create function pg_temp.td1() returns text language sql immutable as $$
  select E'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
$$;
create function pg_temp.td1_bad() returns text language sql immutable as $$
  select E'I<UTOD231458908<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
$$;
create function pg_temp.td3() returns text language sql immutable as $$
  select E'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10'
$$;

-- check_result.details as the flow function builds them (MrzCheckDetails): outcomes and counts only.
create function pg_temp.read_details(capture uuid, valid boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source', 'mrz_phone', 'parserVersion', 'mrz-v1', 'captureId', capture, 'result', 'read', 'reason', null,
    'expectedFormat', 'TD1', 'format', 'TD1',
    'checks', jsonb_build_object('documentNumber', valid, 'birthDate', true, 'expiryDate', true, 'composite', valid),
    'documentCodeFits', true, 'datesValid', true,
    'attempts', 1, 'corrections', 0, 'engine', 'tesseract.js-7.0.0/mrz-1', 'ms', 850)
$$;
create function pg_temp.unreadable_details(capture uuid, expected text) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source', 'mrz_phone', 'parserVersion', 'mrz-v1', 'captureId', capture, 'result', 'unreadable',
    'reason', 'not_found', 'expectedFormat', expected, 'format', null, 'checks', null,
    'documentCodeFits', null, 'datesValid', null,
    'attempts', 3, 'corrections', null, 'engine', 'tesseract.js-7.0.0/mrz-1', 'ms', null)
$$;

grant execute on function pg_temp.assert_eq(bigint, bigint, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_text(text, text, text) to anon, authenticated, service_role;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.td1() to anon, authenticated, service_role;
grant execute on function pg_temp.td1_bad() to anon, authenticated, service_role;
grant execute on function pg_temp.td3() to anon, authenticated, service_role;
grant execute on function pg_temp.read_details(uuid, boolean) to anon, authenticated, service_role;
grant execute on function pg_temp.unreadable_details(uuid, text) to anon, authenticated, service_role;

insert into public.api_client (id, name, api_key_hash) values ('d0000000-0000-0000-0000-000000000001', 'm2-test-client', 'disabled:m2');
insert into public.applicant (id, api_client_id, external_user_id)
  values ('d2000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'm2-rider-1');

-- The migration on a database still at M1 ---------------------------------------------------------
-- Rewinds the M2 objects inside a transaction, adds sessions declared with the M1 'cni', then
-- replays the migration file itself. A new M2 object that is not rewound here makes the replay fail.
begin;
drop function public.staff_read_document_data(uuid, uuid, text);
drop function public.flow_record_mrz(uuid, uuid, text, text, public.check_outcome, jsonb);
drop table public.extracted_document_data;
alter table public.check_result drop column capture_id;
alter table public.verification drop constraint verification_declared_document_check;
-- Not validated: rows written by the earlier test files already use the M2 names.
alter table public.verification add constraint verification_declared_document_check
  check (declared_document in ('cni', 'passport', 'residence_permit', 'driving_licence', 'voter_card')) not valid;
insert into public.verification (id, applicant_id, attempt_no, status, declared_document) values
  ('d3000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-000000000001', 901, 'in_progress', 'cni'),
  ('d3000000-0000-0000-0000-0000000000a2', 'd2000000-0000-0000-0000-000000000001', 902, 'submitted', 'cni'),
  ('d3000000-0000-0000-0000-0000000000a3', 'd2000000-0000-0000-0000-000000000001', 903, 'in_progress', 'passport'),
  ('d3000000-0000-0000-0000-0000000000a4', 'd2000000-0000-0000-0000-000000000001', 904, 'created', null);
-- Hides "extension pgcrypto already exists, skipping".
set local client_min_messages = warning;
\ir ../migrations/20261015000000_m2_mrz.sql
set local client_min_messages = notice;
select pg_temp.assert_eq((select count(*) from public.verification where declared_document = 'cni'), 0,
  'migration: no session keeps the M1 ''cni''');
select pg_temp.assert_eq((select count(*) from public.verification
  where id in ('d3000000-0000-0000-0000-0000000000a1', 'd3000000-0000-0000-0000-0000000000a2')
    and declared_document = 'cni_legacy'), 2,
  'migration: sessions declared ''cni'' become ''cni_legacy'', whatever their status');
select pg_temp.assert_eq((select count(*) from public.verification
  where (id = 'd3000000-0000-0000-0000-0000000000a3' and declared_document = 'passport')
     or (id = 'd3000000-0000-0000-0000-0000000000a4' and declared_document is null)), 2,
  'migration: other documents and undeclared sessions are left as they were');
select pg_temp.assert_eq((select count(*) from vault.secrets where name = 'document_data_key_v1'), 1,
  'migration: running it on a database that already has the key does not create a second one');
rollback;

-- Schema -------------------------------------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto' and n.nspname = 'extensions'), 1, 'pgcrypto is installed in the extensions schema');
select pg_temp.assert_eq((select count(*) from vault.decrypted_secrets
  where name = 'document_data_key_v1' and length(decode(decrypted_secret, 'base64')) = 32), 1,
  'the migration created one 32-byte document data key in Vault');
select pg_temp.assert_true((select relrowsecurity from pg_class where oid = 'public.extracted_document_data'::regclass),
  'RLS is enabled on extracted_document_data');
select pg_temp.assert_eq((select count(*) from pg_policies where schemaname = 'public' and tablename = 'extracted_document_data'), 0,
  'extracted_document_data has no policy');
select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.extracted_document_data', 'select, insert, update, delete, truncate, references, trigger')
  and not has_table_privilege('authenticated', 'public.extracted_document_data', 'select, insert, update, delete, truncate, references, trigger'),
  'anon and authenticated have no right on extracted_document_data');
select pg_temp.assert_eq((select count(*) from pg_constraint
  where contype = 'f' and confdeltype = 'c' and confrelid in ('public.verification'::regclass, 'public.capture'::regclass)
    and conrelid = 'public.extracted_document_data'::regclass), 2,
  'document data is deleted with its verification and its capture');
select pg_temp.assert_eq((select count(*) from pg_constraint
  where contype = 'f' and confdeltype = 'c' and confrelid = 'public.capture'::regclass
    and conrelid = 'public.check_result'::regclass), 1,
  'check_result.capture_id references capture, deleted with it');
select pg_temp.assert_eq((select count(*) from pg_indexes where schemaname = 'public'
  and indexname in ('extracted_document_data_verification_idx', 'extracted_document_data_capture_id_source_key',
                    'check_result_capture_check_idx')), 3,
  'the foreign keys of extracted_document_data and check_result.capture_id are indexed');

begin;
insert into public.verification (applicant_id, attempt_no, declared_document)
  select 'd2000000-0000-0000-0000-000000000001', 100 + n, d
  from unnest(array['cni_biometric', 'cni_legacy', 'passport', 'residence_permit', 'driving_licence', 'voter_card'])
    with ordinality as t(d, n);
select pg_temp.assert_eq((select count(*) from public.verification
  where applicant_id = 'd2000000-0000-0000-0000-000000000001' and attempt_no > 100), 6,
  'declared_document accepts the new and the old CNI and the four other documents');
do $$ begin
  insert into public.verification (applicant_id, attempt_no, declared_document)
    values ('d2000000-0000-0000-0000-000000000001', 99, 'cni');
  raise exception 'FAIL: the M1 ''cni'' was stored';
exception when check_violation then raise notice 'ok: declared_document refuses the M1 ''cni''';
end $$;
rollback;

-- Fixtures (as superuser) ----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d1000000-0000-0000-0000-000000000001', 'admin@m2.test'),
  ('d1000000-0000-0000-0000-000000000002', 'supervisor@m2.test'),
  ('d1000000-0000-0000-0000-000000000003', 'reviewer@m2.test'),
  ('d1000000-0000-0000-0000-000000000004', 'other-reviewer@m2.test'),
  ('d1000000-0000-0000-0000-000000000005', 'former-supervisor@m2.test'),
  ('d1000000-0000-0000-0000-000000000006', 'not-staff@m2.test');
insert into public.staff_profile (user_id, role, full_name, active) values
  ('d1000000-0000-0000-0000-000000000001', 'admin', 'M2 Admin', true),
  ('d1000000-0000-0000-0000-000000000002', 'supervisor', 'M2 Supervisor', true),
  ('d1000000-0000-0000-0000-000000000003', 'reviewer', 'M2 Reviewer', true),
  ('d1000000-0000-0000-0000-000000000004', 'reviewer', 'M2 Other Reviewer', true),
  ('d1000000-0000-0000-0000-000000000005', 'supervisor', 'M2 Former Supervisor', false);

-- 1: new CNI whose back was retaken once; 2: a passport; 3: an old CNI (no MRZ, nothing to read).
insert into public.verification (id, applicant_id, attempt_no, status, declared_document) values
  ('d3000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 1, 'in_progress', 'cni_biometric'),
  ('d3000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000001', 2, 'in_progress', 'passport'),
  ('d3000000-0000-0000-0000-000000000003', 'd2000000-0000-0000-0000-000000000001', 3, 'in_review', 'cni_legacy');
insert into public.capture (id, verification_id, kind, storage_path, sha256, mime_type, byte_size, deleted_at) values
  ('d4000000-0000-0000-0000-000000000011', 'd3000000-0000-0000-0000-000000000001', 'document_front', 'm2/1/front.jpg', 'm2-1-front', 'image/jpeg', 20000, null),
  ('d4000000-0000-0000-0000-000000000012', 'd3000000-0000-0000-0000-000000000001', 'document_back', 'm2/1/back-1.jpg', 'm2-1-back-1', 'image/jpeg', 20000, null),
  ('d4000000-0000-0000-0000-000000000013', 'd3000000-0000-0000-0000-000000000001', 'document_back', 'm2/1/back-2.jpg', 'm2-1-back-2', 'image/jpeg', 20000, null),
  ('d4000000-0000-0000-0000-000000000014', 'd3000000-0000-0000-0000-000000000001', 'document_back', 'm2/1/back-erased.jpg', 'm2-1-back-erased', 'image/jpeg', 20000, now()),
  ('d4000000-0000-0000-0000-000000000021', 'd3000000-0000-0000-0000-000000000002', 'document_front', 'm2/2/front-1.jpg', 'm2-2-front-1', 'image/jpeg', 20000, null),
  ('d4000000-0000-0000-0000-000000000022', 'd3000000-0000-0000-0000-000000000002', 'document_front', 'm2/2/front-2.jpg', 'm2-2-front-2', 'image/jpeg', 20000, null);
insert into public.review_task (verification_id, status, assigned_to, assigned_at) values
  ('d3000000-0000-0000-0000-000000000001', 'assigned', 'd1000000-0000-0000-0000-000000000003', now()),
  ('d3000000-0000-0000-0000-000000000003', 'assigned', 'd1000000-0000-0000-0000-000000000004', now());

-- flow_record_mrz ------------------------------------------------------------------------------------
-- First try on the back: the rider continued anyway with a wrong check digit (flagged).
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000012',
    pg_temp.td1_bad(), 'TD1', 'flag', pg_temp.read_details('d4000000-0000-0000-0000-000000000012', false)),
  'ok', 'record: a flagged read is recorded');
commit;

-- The retaken back reads correctly. A separate transaction, so it is recorded later.
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000013',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000013', true)),
  'ok', 'record: a valid read is recorded');
select pg_temp.assert_eq((select count(*) from public.check_result
  where capture_id = 'd4000000-0000-0000-0000-000000000013' and verification_id = 'd3000000-0000-0000-0000-000000000001'
    and check_name = 'mrz' and check_version = 'mrz-v1' and outcome = 'pass'
    and details = pg_temp.read_details('d4000000-0000-0000-0000-000000000013', true)), 1,
  'record: one mrz check result for the photo, versioned by the parser, with the details as given');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data
  where capture_id = 'd4000000-0000-0000-0000-000000000013' and verification_id = 'd3000000-0000-0000-0000-000000000001'
    and source = 'mrz_phone' and format = 'TD1' and key_name = 'document_data_key_v1'), 1,
  'record: one encrypted row for the photo, naming its key');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data edd
  where edd.verification_id = 'd3000000-0000-0000-0000-000000000001'
    and (position(convert_to(pg_temp.td1(), 'UTF8') in edd.ciphertext) > 0
      or position(convert_to(pg_temp.td1_bad(), 'UTF8') in edd.ciphertext) > 0
      or position('D23145890'::bytea in edd.ciphertext) > 0
      or position('ERIKSSON'::bytea in edd.ciphertext) > 0
      or position('7408122'::bytea in edd.ciphertext) > 0)), 0,
  'record: the ciphertext contains neither the lines nor any field of them');
-- OpenPGP (RFC 4880 5.3): the message opens with the symmetric-key session packet, whose 4th byte
-- names the cipher: 9 is AES-256 (pgcrypto's default would be 7, AES-128).
select pg_temp.assert_eq((select get_byte(edd.ciphertext, 3) from public.extracted_document_data edd
    where edd.capture_id = 'd4000000-0000-0000-0000-000000000013'), 9,
  'record: the lines are encrypted with AES-256');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'mrz.record' and actor_type = 'rider' and actor_id = 'd3000000-0000-0000-0000-000000000001'
    and target_type = 'verification' and target_id = 'd3000000-0000-0000-0000-000000000001'), 2,
  'record: each recorded read writes one mrz.record audit event');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'mrz.record' and target_id = 'd3000000-0000-0000-0000-000000000001'
    and details = '{"captureId": "d4000000-0000-0000-0000-000000000013", "outcome": "pass", "result": "read"}'::jsonb), 1,
  'record: the audit details hold only the capture, the outcome and the result');
select pg_temp.assert_eq((select count(*) from public.audit_event ae
  where ae.action = 'mrz.record'
    and (row_to_json(ae)::text like '%ERIKSSON%' or row_to_json(ae)::text like '%D2314589%'
         or row_to_json(ae)::text like '%7408122%' or row_to_json(ae)::text like '%<<<%')), 0,
  'record: the audit log holds nothing read from the document');
select pg_temp.assert_eq((select count(*) from public.check_result cr
  where cr.check_name = 'mrz'
    and (row_to_json(cr)::text like '%ERIKSSON%' or row_to_json(cr)::text like '%D2314589%'
         or row_to_json(cr)::text like '%<<<%')), 0,
  'record: the check result holds nothing read from the document');
-- Back to the table owner, who may read Vault, to look inside.
reset role;
select pg_temp.assert_text((select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret)
    from public.extracted_document_data edd join vault.decrypted_secrets ds on ds.name = edd.key_name
    where edd.capture_id = 'd4000000-0000-0000-0000-000000000013'),
  pg_temp.td1(), 'record: the ciphertext decrypts to the lines with the Vault key');
do $$ begin
  perform extensions.pgp_sym_decrypt(edd.ciphertext, encode(extensions.gen_random_bytes(32), 'base64'))
    from public.extracted_document_data edd where edd.capture_id = 'd4000000-0000-0000-0000-000000000013';
  raise exception 'FAIL: the ciphertext was decrypted with another key';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: record: the ciphertext does not decrypt with another key';
end $$;
commit;

-- Idempotency: a retried report, or a different one for the same photo, changes nothing.
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000013',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000013', true)),
  'exists', 'record: the same report again returns exists');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000013',
    pg_temp.td1_bad(), 'TD1', 'flag', pg_temp.read_details('d4000000-0000-0000-0000-000000000013', false)),
  'exists', 'record: another report for an already recorded photo returns exists');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000013',
    null, null, 'flag', pg_temp.unreadable_details('d4000000-0000-0000-0000-000000000013', 'TD1')),
  'exists', 'record: an unreadable report for an already recorded photo returns exists');
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'd4000000-0000-0000-0000-000000000013'), 1,
  'record: still one check result for the photo');
select pg_temp.assert_eq((select count(*) from public.check_result
  where capture_id = 'd4000000-0000-0000-0000-000000000013' and outcome = 'pass'), 1,
  'record: the first outcome is kept');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data where capture_id = 'd4000000-0000-0000-0000-000000000013'), 1,
  'record: still one encrypted row for the photo');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'mrz.record' and target_id = 'd3000000-0000-0000-0000-000000000001'), 2,
  'record: exists writes no audit event');
commit;

-- Refusals: nothing is written.
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000021',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000021', true)),
  'not_found', 'record: a capture of another verification is refused');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000011',
    pg_temp.td3(), 'TD3', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000011', true)),
  'not_found', 'record: another verification cannot record on this one''s capture');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000014',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000014', true)),
  'not_found', 'record: an erased capture is refused');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-0000000000ff',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-0000000000ff', true)),
  'not_found', 'record: an unknown capture is refused');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', null,
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details(null, true)),
  'not_found', 'record: a missing capture is refused');
do $$
declare
  bad record;
begin
  for bad in select * from (values
    ('TD3 lines as TD1', pg_temp.td3(), 'TD1'),
    ('TD1 lines as TD3', pg_temp.td1(), 'TD3'),
    ('lower case', lower(pg_temp.td1()), 'TD1'),
    ('a trailing newline', pg_temp.td1() || E'\n', 'TD1'),
    ('two TD1 lines', E'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6', 'TD1'),
    ('a space', replace(pg_temp.td1(), 'ANNA<', 'ANNA '), 'TD1'),
    ('an unknown format', pg_temp.td1(), 'TD2'),
    ('no format', pg_temp.td1(), null)
  ) as t(label, lines, format) loop
    begin
      perform public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011',
        bad.lines, bad.format, 'flag', pg_temp.read_details('d4000000-0000-0000-0000-000000000011', false));
      raise exception 'FAIL: record accepted %', bad.label;
    exception when invalid_parameter_value then
      if position('ERIKSSON' in sqlerrm) > 0 or position('<<' in sqlerrm) > 0 then
        raise exception 'FAIL: the error for % repeats the lines', bad.label;
      end if;
    end;
  end loop;
  raise notice 'ok: record: lines that are not an MRZ of the given format are refused, without echoing them';
end $$;
do $$ begin
  perform public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000011', true) - 'parserVersion');
  raise exception 'FAIL: a check result without a parser version was stored';
exception when not_null_violation then raise notice 'ok: record: a check result needs the parser version';
end $$;
select pg_temp.assert_eq((select count(*) from public.check_result
  where capture_id in ('d4000000-0000-0000-0000-000000000011', 'd4000000-0000-0000-0000-000000000014',
                       'd4000000-0000-0000-0000-000000000021')), 0,
  'record: refused calls write no check result');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data
  where capture_id in ('d4000000-0000-0000-0000-000000000011', 'd4000000-0000-0000-0000-000000000014',
                       'd4000000-0000-0000-0000-000000000021')), 0,
  'record: refused calls store no document data');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'mrz.record' and target_id in ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002')), 2,
  'record: refused calls write no audit event');
commit;

-- Unreadable on the phone: the check is recorded (flagged), no document data is stored.
begin;
set local role service_role;
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000021',
    null, null, 'flag', pg_temp.unreadable_details('d4000000-0000-0000-0000-000000000021', 'TD3')),
  'ok', 'record: an unreadable report is recorded');
select pg_temp.assert_eq((select count(*) from public.check_result
  where capture_id = 'd4000000-0000-0000-0000-000000000021' and outcome = 'flag' and details ->> 'result' = 'unreadable'), 1,
  'record: an unreadable report gives a flagged check result');
select pg_temp.assert_eq((select count(*) from public.extracted_document_data where verification_id = 'd3000000-0000-0000-0000-000000000002'), 0,
  'record: an unreadable report stores no document data');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'mrz.record' and target_id = 'd3000000-0000-0000-0000-000000000002'
    and details = '{"captureId": "d4000000-0000-0000-0000-000000000021", "outcome": "flag", "result": "unreadable"}'::jsonb), 1,
  'record: an unreadable report is audited');
commit;

-- Without its key, nothing can be encrypted: the call fails instead of storing plain text.
begin;
delete from vault.secrets where name = 'document_data_key_v1';
set local role service_role;
do $$ begin
  perform public.flow_record_mrz('d3000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000022',
    pg_temp.td3(), 'TD3', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000022', true));
  raise exception 'FAIL: lines were recorded without the key';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: record: a missing key fails loudly';
end $$;
select pg_temp.assert_eq((select count(*) from public.check_result where capture_id = 'd4000000-0000-0000-0000-000000000022'), 0,
  'record: a missing key leaves no check result behind');
select pg_temp.assert_text(public.flow_record_mrz('d3000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000022',
    null, null, 'flag', pg_temp.unreadable_details('d4000000-0000-0000-0000-000000000022', 'TD3')),
  'ok', 'record: an unreadable report needs no key');
rollback;

-- One MRZ check per photo, enforced by the table too. Checks not tied to a photo are not limited.
begin;
do $$ begin
  insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome)
    values ('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000013', 'mrz', 'mrz-v1', 'flag');
  raise exception 'FAIL: a second mrz check was stored for the same photo';
exception when unique_violation then raise notice 'ok: one mrz check result per photo';
end $$;
insert into public.check_result (verification_id, check_name, check_version, outcome) values
  ('d3000000-0000-0000-0000-000000000001', 'face_match', 'v0', 'pass'),
  ('d3000000-0000-0000-0000-000000000001', 'face_match', 'v0', 'pass');
select pg_temp.assert_eq((select count(*) from public.check_result
  where verification_id = 'd3000000-0000-0000-0000-000000000001' and capture_id is null), 2,
  'checks without a photo are not limited by the index');
rollback;

-- Erasing a photo row takes its document data and check result with it.
begin;
delete from public.capture where id = 'd4000000-0000-0000-0000-000000000013';
select pg_temp.assert_eq((select count(*) from public.extracted_document_data where capture_id = 'd4000000-0000-0000-0000-000000000013')
  + (select count(*) from public.check_result where capture_id = 'd4000000-0000-0000-0000-000000000013'), 0,
  'deleting a capture deletes its document data and check result');
rollback;

-- Who can see the data ---------------------------------------------------------------------------------
begin;
set local role anon;
do $$ begin
  perform count(*) from public.extracted_document_data;
  raise exception 'FAIL: anon could read extracted_document_data';
exception when insufficient_privilege then raise notice 'ok: anon cannot read extracted_document_data';
end $$;
do $$ begin
  perform count(*) from public.check_result;
  raise exception 'FAIL: anon could read check_result';
exception when insufficient_privilege then raise notice 'ok: anon cannot read check_result';
end $$;
rollback;

begin;
set local role authenticated;
do $$
declare
  who record;
begin
  for who in select * from (values
    ('d1000000-0000-0000-0000-000000000006', 'a signed-in user who is not staff'),
    ('d1000000-0000-0000-0000-000000000003', 'the assigned reviewer'),
    ('d1000000-0000-0000-0000-000000000002', 'a supervisor'),
    ('d1000000-0000-0000-0000-000000000001', 'an admin')
  ) as t(id, label) loop
    perform set_config('request.jwt.claim.sub', who.id, true);
    begin
      perform count(*) from public.extracted_document_data;
      raise exception 'FAIL: % could read extracted_document_data', who.label;
    exception when insufficient_privilege then
      raise notice 'ok: % cannot read extracted_document_data, not even the ciphertext', who.label;
    end;
    begin
      insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
      values ('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011', 'mrz_phone', 'TD1', '\x00', 'x');
      raise exception 'FAIL: % could write extracted_document_data', who.label;
    exception when insufficient_privilege then
      raise notice 'ok: % cannot write extracted_document_data', who.label;
    end;
  end loop;
end $$;
-- The MRZ check results follow the check_result rule: supervisors see all, reviewers their case.
set local request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000003';
select pg_temp.assert_eq((select count(*) from public.check_result where check_name = 'mrz'), 2,
  'the assigned reviewer sees the mrz checks of their case only');
set local request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000004';
select pg_temp.assert_eq((select count(*) from public.check_result where check_name = 'mrz'), 0,
  'another reviewer sees no mrz check of a case not assigned to them');
set local request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000002';
select pg_temp.assert_eq((select count(*) from public.check_result where check_name = 'mrz'), 3,
  'a supervisor sees every mrz check');
select pg_temp.assert_eq((select count(*) from public.check_result
  where check_name = 'mrz' and capture_id = 'd4000000-0000-0000-0000-000000000013'), 1,
  'the dashboard can match a check to its photo');
rollback;

-- staff_read_document_data ----------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table m2_supervisor_read as
  select * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor')
    with ordinality as r(capture_id, source, format, lines, recorded_at, n);
select pg_temp.assert_eq((select count(*) from m2_supervisor_read), 2, 'read: a supervisor gets both reads of the case');
select pg_temp.assert_true((select array_agg(capture_id order by n) from m2_supervisor_read)
    = array['d4000000-0000-0000-0000-000000000013', 'd4000000-0000-0000-0000-000000000012']::uuid[],
  'read: the latest read comes first');
select pg_temp.assert_text((select lines from m2_supervisor_read where n = 1), pg_temp.td1(),
  'read: the lines round-trip through the encryption');
select pg_temp.assert_text((select lines from m2_supervisor_read where n = 2), pg_temp.td1_bad(),
  'read: a flagged read comes back exactly as the phone sent it');
select pg_temp.assert_eq((select count(*) from m2_supervisor_read
  where source = 'mrz_phone' and format = 'TD1' and recorded_at is not null), 2,
  'read: each row has its source, format and time');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'document_data.view' and actor_type = 'staff' and actor_id = 'd1000000-0000-0000-0000-000000000002'
    and target_type = 'verification' and target_id = 'd3000000-0000-0000-0000-000000000001'
    and details = '{"role": "supervisor", "items": 2}'::jsonb), 1,
  'read: writes one document_data.view audit event with the role and the number of items');

create temp table m2_reviewer_read as
  select * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', 'reviewer');
select pg_temp.assert_eq((select count(*) from m2_reviewer_read), 2, 'read: the assigned reviewer gets the case''s data');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'document_data.view' and actor_id = 'd1000000-0000-0000-0000-000000000003'
    and details = '{"role": "reviewer", "items": 2}'::jsonb), 1,
  'read: the reviewer''s read is audited with their role');

select pg_temp.assert_eq((select count(*) from public.staff_read_document_data(
    'd3000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000002', 'supervisor')), 0,
  'read: a case without data returns no row');
select pg_temp.assert_eq((select count(*) from public.audit_event
  where action = 'document_data.view' and target_id = 'd3000000-0000-0000-0000-000000000003'
    and details = '{"role": "supervisor", "items": 0}'::jsonb), 1,
  'read: a read that finds nothing is audited too');
select pg_temp.assert_eq((select count(*) from public.staff_read_document_data(
    'd3000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000002', 'supervisor')), 0,
  'read: an unreadable MRZ leaves nothing to read');
commit;

-- The audit entries of a case are in the order things happened.
select pg_temp.assert_true((select array_agg(action order by id) from public.audit_event
    where target_id = 'd3000000-0000-0000-0000-000000000001')
  = array['mrz.record', 'mrz.record', 'document_data.view', 'document_data.view'],
  'audit: the case''s entries are in order (two reads recorded, then two views)');

-- Refused reads: nothing returned, nothing audited.
begin;
set local role service_role;
do $$
declare
  who record;
begin
  for who in select * from (values
    ('d1000000-0000-0000-0000-000000000001'::uuid, 'admin', 'an admin'),
    ('d1000000-0000-0000-0000-000000000004'::uuid, 'reviewer', 'a reviewer the case is not assigned to'),
    ('d1000000-0000-0000-0000-000000000003'::uuid, 'supervisor', 'a reviewer claiming to be a supervisor'),
    ('d1000000-0000-0000-0000-000000000005'::uuid, 'supervisor', 'a deactivated supervisor'),
    ('d1000000-0000-0000-0000-000000000006'::uuid, 'supervisor', 'a user who is not staff'),
    ('d1000000-0000-0000-0000-000000000002'::uuid, null, 'a call without a role'),
    (null, 'supervisor', 'a call without an actor')
  ) as t(actor, role, label) loop
    begin
      perform * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', who.actor, who.role);
      raise exception 'FAIL: % read the document data', who.label;
    exception when insufficient_privilege then
      raise notice 'ok: read: % is refused', who.label;
    end;
  end loop;
end $$;
select pg_temp.assert_eq((select count(*) from public.audit_event where action = 'document_data.view'), 4,
  'read: refused reads write no audit event');
rollback;

-- No audit entry, no data: when the entry cannot be written, the read returns nothing.
begin;
create function public.m2_test_refuse_view_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'document_data.view' then raise exception 'audit store unavailable'; end if;
  return new;
end $$;
create trigger m2_test_refuse_view_audit before insert on public.audit_event
  for each row execute function public.m2_test_refuse_view_audit();
set local role service_role;
do $$
declare
  got integer := 0;
  r record;
begin
  begin
    for r in select * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001',
                                                          'd1000000-0000-0000-0000-000000000002', 'supervisor') loop
      got := got + 1;
    end loop;
  exception when raise_exception then
    if got > 0 then raise exception 'FAIL: % rows came back although the audit failed', got; end if;
    raise notice 'ok: read: when the audit entry cannot be written, nothing is returned';
    return;
  end;
  raise exception 'FAIL: the read succeeded although its audit entry could not be written';
end $$;
rollback;

-- A rider's report that lands during a read: the audit entry counts exactly the rows returned.
-- Each statement of the read sees the rows committed before it starts, so the read must not count
-- one set of rows and decrypt another. A trigger on the read's own audit entry stands in for a
-- report committed between the two (the window a concurrent flow_record_mrz can hit).
begin;
create function public.m2_test_report_during_view() returns trigger language plpgsql as $$
begin
  if new.action = 'document_data.view' then
    insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
    select 'd3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011', 'mrz_phone', 'TD1',
           extensions.pgp_sym_encrypt(pg_temp.td1(), ds.decrypted_secret), ds.name
    from vault.decrypted_secrets ds where ds.name = 'document_data_key_v1';
  end if;
  return new;
end $$;
create trigger m2_test_report_during_view after insert on public.audit_event
  for each row execute function public.m2_test_report_during_view();
set local role service_role;
create temp table m2_racing_read as
  select * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor');
reset role;
select pg_temp.assert_eq((select count(*) from public.extracted_document_data
  where verification_id = 'd3000000-0000-0000-0000-000000000001'), 3,
  'read during a report: the report landed while the read was under way');
select pg_temp.assert_eq((select (details ->> 'items')::bigint from public.audit_event
  where action = 'document_data.view' order by id desc limit 1), 2,
  'read during a report: the audit entry counts the rows there when the read began');
select pg_temp.assert_eq((select count(*) from m2_racing_read), 2,
  'read during a report: the read returns exactly the rows its audit entry counts');
rollback;

-- A missing or replaced key fails loudly instead of returning empty or garbled lines.
begin;
delete from vault.secrets where name = 'document_data_key_v1';
set local role service_role;
do $$ begin
  perform * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor');
  raise exception 'FAIL: a read succeeded without the key';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: read: a missing key fails loudly';
end $$;
rollback;

begin;
update vault.secrets set secret = encode(extensions.gen_random_bytes(32), 'base64') where name = 'document_data_key_v1';
set local role service_role;
do $$ begin
  perform * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor');
  raise exception 'FAIL: a read succeeded with another key';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: read: data encrypted under another key fails loudly';
end $$;
rollback;

-- RPC privileges: service role only ---------------------------------------------------------------------
select pg_temp.assert_eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('flow_record_mrz', 'staff_read_document_data')
    and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
    and p.prosecdef and p.proconfig = array['search_path=""']), 2,
  'M2 RPCs are plpgsql, SECURITY DEFINER, with an empty search_path');
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.flow_record_mrz(uuid, uuid, text, text, public.check_outcome, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.staff_read_document_data(uuid, uuid, text)', 'execute'),
  'service role can execute the M2 RPCs');
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.flow_record_mrz(uuid, uuid, text, text, public.check_outcome, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.staff_read_document_data(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.flow_record_mrz(uuid, uuid, text, text, public.check_outcome, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.staff_read_document_data(uuid, uuid, text)', 'execute')
  and not has_function_privilege('public', 'public.staff_read_document_data(uuid, uuid, text)', 'execute'),
  'anon, authenticated and public have no execute right on the M2 RPCs');

begin;
set local role anon;
do $$ begin
  perform public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000011', true));
  raise exception 'FAIL: anon called flow_record_mrz';
exception when insufficient_privilege then raise notice 'ok: anon cannot call flow_record_mrz';
end $$;
do $$ begin
  perform * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor');
  raise exception 'FAIL: anon called staff_read_document_data';
exception when insufficient_privilege then raise notice 'ok: anon cannot call staff_read_document_data';
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000002';
do $$ begin
  perform public.flow_record_mrz('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000011',
    pg_temp.td1(), 'TD1', 'pass', pg_temp.read_details('d4000000-0000-0000-0000-000000000011', true));
  raise exception 'FAIL: a supervisor called flow_record_mrz';
exception when insufficient_privilege then raise notice 'ok: signed-in staff cannot call flow_record_mrz';
end $$;
do $$ begin
  perform * from public.staff_read_document_data('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'supervisor');
  raise exception 'FAIL: a supervisor called staff_read_document_data directly';
exception when insufficient_privilege then raise notice 'ok: signed-in staff (even a supervisor) cannot call staff_read_document_data directly';
end $$;
rollback;

select pg_temp.assert_true(public.audit_chain_first_break() is null, 'audit hash chain is intact after M2');
