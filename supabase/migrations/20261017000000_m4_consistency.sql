-- Confiance Verify — M4: consistency checks and first risk flags.
--   * check_result: a new case-level check, `consistency` (at most one per case, by the M3 unique index
--     where capture_id is null). Its details hold generic codes only: {flags, provisional, basis,
--     mismatches} (ConsistencyDetails in contract.ts). The database refuses any other key, and any
--     code outside the contract's lists.
--   * worker_case_snapshot also returns, as `documentData`, the values the consistency checks compare:
--     the code lines read by the server (mrz_server) and the printed fields (ocr_server, never the card
--     sub-type) of the newest live photo of each side, decrypted here. The Edge Function decides from
--     them and keeps only generic codes; the values never reach check_result, audit_event or a log.
--   * The firm consistency flags join the document_policy reasons; the Edge Function sends them with
--     the other reasons it decides, so worker_refresh_policy keeps them as before.
-- No new table or column, and nothing is dropped: the two existing functions keep their signatures.
--
-- Who may read the decrypted values. worker_case_snapshot is for the service role only (M3), that is
-- the `worker` and `flow` Edge Functions, which decide the case-level checks. A staff member never
-- gets them this way: staff_read_document_data, audited before decryption, stays their only way.

-- ---------------------------------------------------------------------------
-- The values the consistency checks compare, decrypted
-- ---------------------------------------------------------------------------
-- For the newest live photo of each document side that has any: {captureId, kind, mrzLines (the
-- server's code lines joined with a newline, or null), fields (WorkerFields without the sub-type, or
-- null)}. Fails loudly when a row's key is missing from Vault, rather than decide from missing data.
-- Runs inside worker_case_snapshot (SECURITY DEFINER), which may read Vault.
create function private.worker_case_document_data(p_verification uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  items jsonb;
begin
  if exists (
    select 1 from private.worker_newest_captures(p_verification) n
    join public.extracted_document_data edd on edd.capture_id = n.capture_id and edd.source in ('mrz_server', 'ocr_server')
    where not exists (select 1 from vault.decrypted_secrets ds where ds.name = edd.key_name and ds.decrypted_secret is not null)
  ) then
    raise exception 'worker_case_document_data: a document data key is missing from Vault';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'captureId', n.capture_id,
           'kind', n.kind,
           'mrzLines', (
             select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret)
               from public.extracted_document_data edd
               join vault.decrypted_secrets ds on ds.name = edd.key_name
              where edd.capture_id = n.capture_id and edd.source = 'mrz_server'
              order by edd.created_at desc, edd.id desc
              limit 1),
           -- The sub-type (which residence card, refugee included) is never needed to compare.
           'fields', (
             select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret)::jsonb - 'subtype'
               from public.extracted_document_data edd
               join vault.decrypted_secrets ds on ds.name = edd.key_name
              where edd.capture_id = n.capture_id and edd.source = 'ocr_server'
              order by edd.created_at desc, edd.id desc
              limit 1))
         order by n.kind), '[]'::jsonb)
    into items
    from private.worker_newest_captures(p_verification) n
   where exists (select 1 from public.extracted_document_data edd
                 where edd.capture_id = n.capture_id and edd.source in ('mrz_server', 'ocr_server'));
  return items;
end;
$$;

-- As in M3, plus `documentData`. The fingerprint still covers only the case inputs: the values change
-- only together with them (a result recorded, a photo replaced), so a stale snapshot is still refused.
create or replace function public.worker_case_snapshot(p_verification uuid default null, p_job uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  j public.worker_job;
  target uuid := p_verification;
  inputs jsonb;
  job jsonb := null;
begin
  if p_job is not null then
    select * into j from public.worker_job wj where wj.id = p_job;
    if not found then
      return null;
    end if;
    target := j.verification_id;
    job := jsonb_build_object(
      'id', j.id, 'status', j.status, 'attempts', j.attempts, 'captureId', j.capture_id, 'kind', j.kind,
      'captureLive', exists (select 1 from public.capture c where c.id = j.capture_id and c.deleted_at is null));
  end if;
  inputs := private.worker_case_inputs(target);
  if inputs is null then
    return null;
  end if;
  return inputs || jsonb_build_object(
    'verificationId', target, 'fingerprint', md5(inputs::text), 'job', job,
    'documentData', private.worker_case_document_data(target));
end;
$$;

-- ---------------------------------------------------------------------------
-- Writing the case-level checks: the M3 rules, plus `consistency`
-- ---------------------------------------------------------------------------
-- p_case: {version, classification: {outcome, score, details} or null, reasons: [...], consistency:
-- {outcome, details} or null}. Null (or no consistency key): the consistency check is dropped. Its
-- details may hold only the keys of ConsistencyDetails, with the contract's codes (CONSISTENCY_FLAGS,
-- MISMATCH_KINDS): supervisors and admins read check_result, and nothing read from a document may
-- reach it. The caller holds the case lock.
create or replace function private.worker_apply_case(p_verification uuid, p_case jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  cls jsonb := p_case -> 'classification';
  con jsonb := p_case -> 'consistency';
  details jsonb := con -> 'details';
  flag_codes constant text[] := array['document_expired', 'under_18', 'mrz_print_mismatch', 'date_logic', 'number_format'];
  mismatch_codes constant text[] := array['name', 'number', 'birth_date', 'expiry_date'];
begin
  if cls is not null and jsonb_typeof(cls) <> 'null' and (
       jsonb_typeof(cls -> 'details') is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(cls -> 'details') k
                  where k not in ('detected', 'basis', 'provisional', 'matchesDeclared', 'confidence', 'qrPresent'))) then
    raise exception 'worker_apply_case: unexpected classification details' using errcode = 'invalid_parameter_value';
  end if;
  if con is not null and jsonb_typeof(con) <> 'null' and not coalesce(
       jsonb_typeof(details) = 'object'
       and not exists (select 1 from jsonb_object_keys(details) k where k not in ('flags', 'provisional', 'basis', 'mismatches'))
       and jsonb_typeof(details -> 'flags') = 'array'
       and jsonb_typeof(details -> 'provisional') = 'array'
       and jsonb_typeof(details -> 'mismatches') = 'array'
       and details ->> 'basis' in ('mrz', 'printed', 'none')
       and con ->> 'outcome' in ('pass', 'flag', 'skipped')
       and not exists (select 1 from jsonb_array_elements(details -> 'flags') f
                       where jsonb_typeof(f) <> 'string' or f #>> '{}' <> all (flag_codes))
       and not exists (select 1 from jsonb_array_elements(details -> 'provisional') f
                       where jsonb_typeof(f) <> 'string' or f #>> '{}' <> all (flag_codes))
       and not exists (select 1 from jsonb_array_elements(details -> 'mismatches') f
                       where jsonb_typeof(f) <> 'string' or f #>> '{}' <> all (mismatch_codes)), false) then
    raise exception 'worker_apply_case: unexpected consistency details' using errcode = 'invalid_parameter_value';
  end if;

  if cls is null or jsonb_typeof(cls) = 'null' then
    delete from public.check_result cr
     where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'classification';
  else
    insert into public.check_result (verification_id, check_name, check_version, outcome, score, details)
    values (p_verification, 'classification', p_case ->> 'version', (cls ->> 'outcome')::public.check_outcome,
            (cls ->> 'score')::numeric, cls -> 'details')
    on conflict (verification_id, check_name) where capture_id is null
    do update set check_version = excluded.check_version, outcome = excluded.outcome, score = excluded.score,
                  details = excluded.details, created_at = now();
  end if;

  if con is null or jsonb_typeof(con) = 'null' then
    delete from public.check_result cr
     where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'consistency';
  else
    insert into public.check_result (verification_id, check_name, check_version, outcome, details)
    values (p_verification, 'consistency', p_case ->> 'version', (con ->> 'outcome')::public.check_outcome, details)
    on conflict (verification_id, check_name) where capture_id is null
    do update set check_version = excluded.check_version, outcome = excluded.outcome, score = null,
                  details = excluded.details, created_at = now();
  end if;

  perform private.worker_refresh_policy(
    p_verification,
    coalesce(array(select jsonb_array_elements_text(coalesce(p_case -> 'reasons', '[]'::jsonb))), '{}'),
    p_case ->> 'version');
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the new helper is for nobody but its owner (CREATE OR REPLACE keeps the others' grants)
-- ---------------------------------------------------------------------------
revoke execute on function private.worker_case_document_data(uuid) from public;
