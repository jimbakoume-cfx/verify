-- Confiance Verify — M8: risk score, editable thresholds, approve / reject / review.
--   * threshold_config: versioned, append-only (no row is ever edited or removed). The active version is
--     the highest one. Each new version names who made it and why (created_by, note); only an admin can
--     add one, through public.staff_create_threshold_version (called by the audited admin Edge Function),
--     and every version is checked against the rules of risk.ts (private.risk_config_errors) as it is
--     inserted. Version 2 (DEFAULT_THRESHOLD_CONFIG in risk.ts) is the first M8 version.
--   * The assessment of a case: private.risk_facts gathers the signals present and the required checks
--     missing (generic codes only), private.risk_evaluate applies the active version (the same rules as
--     evaluateRisk in risk.ts; supabase/tests/risk_vectors.json is run by both), and the result is stored
--     on the verification (risk_score, risk_recommendation, risk_reasons, threshold_config_version,
--     risk_assessed_at) and audited (risk.assess) whenever it changes.
--   * When: at submit, and again whenever a check of a submitted, undecided case changes (a late worker
--     result, the phone's report, the sweep giving up on a photo), through deferred triggers that run as
--     the writing transaction commits, so they see its final state. A new threshold version re-assesses
--     every submitted, undecided case at once (no redeploy).
--   * Decisions: a staff member approves or rejects through public.staff_decide (the admin Edge
--     Function): the decision records the threshold version, the recommendation and score it was shown,
--     and whether it agreed (for the M12 calibration); the case is closed and audited. Automatic
--     decisions are off (autoDecide false); even on, they apply only to test sessions and never approve
--     a case missing a required check (liveness and face match do not exist before M6 and M7).
-- No table is removed and no existing function is replaced.
--
-- Lock order. Every path locks the verification row FOR NO KEY UPDATE (never FOR UPDATE, which would
-- conflict with the KEY SHARE lock a new photo's foreign key check takes while the M3 trigger waits for
-- the case lock) after any case lock it holds; flow_submit's FOR UPDATE is taken before any other lock.

-- ---------------------------------------------------------------------------
-- The rules' constants (the same lists, in the same order, as risk.ts)
-- ---------------------------------------------------------------------------
create function private.risk_signal_codes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'document_expired', 'under_18', 'image_reused', 'unsupported_document', 'mrz_disagreement',
    'mrz_invalid_server', 'mrz_print_mismatch', 'type_mismatch', 'date_logic', 'number_format',
    'manual_review_document', 'unrecognised_document', 'mrz_unreadable_server', 'mrz_phone_flag',
    'phone_report_missing', 'provisional_classification', 'quality_poor', 'liveness_flag', 'face_match_flag']
$$;

create function private.risk_firm_signals()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'document_expired', 'image_reused', 'unsupported_document', 'mrz_disagreement', 'mrz_invalid_server',
    'mrz_print_mismatch', 'type_mismatch', 'date_logic', 'number_format']
$$;

create function private.risk_required_checks()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['server_checks', 'liveness', 'face_match']
$$;

create function private.risk_declared_documents()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['cni_biometric', 'cni_legacy', 'passport', 'residence_permit', 'driving_licence', 'voter_card']
$$;

-- The rider-facing reason (reason_code) of a reject from its first firm signal (SIGNAL_REJECT_CODES).
create function private.risk_reject_code(p_signal text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_signal
    when 'document_expired' then 'DOC_EXPIRED'
    when 'image_reused' then 'DOC_NOT_ORIGINAL'
    when 'unsupported_document' then 'DOC_UNSUPPORTED'
    when 'mrz_disagreement' then 'DOC_INVALID'
    when 'mrz_invalid_server' then 'DOC_INVALID'
    when 'mrz_print_mismatch' then 'DOC_INVALID'
    when 'type_mismatch' then 'DOC_INVALID'
    when 'date_logic' then 'DOC_INVALID'
    when 'number_format' then 'DOC_INVALID'
    else 'OTHER'
  end
$$;

-- ---------------------------------------------------------------------------
-- Checking a configuration (thresholdConfigErrors in risk.ts): sorted "path:code" strings
-- ---------------------------------------------------------------------------
create function private.risk_score_errors(p_value jsonb, p_path text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then
    return array[p_path || ':not_number'];
  end if;
  v := (p_value #>> '{}')::numeric;
  if v < 0 or v > 1 then
    return array[p_path || ':out_of_range'];
  end if;
  if v * 10000 <> trunc(v * 10000) then
    return array[p_path || ':too_precise'];
  end if;
  return '{}';
end;
$$;

create function private.risk_list_errors(p_value jsonb, p_path text, p_known text[], p_mandatory text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  errors text[] := '{}';
begin
  if jsonb_typeof(p_value) is distinct from 'array' then
    return array[p_path || ':not_array'];
  end if;
  if exists (select 1 from jsonb_array_elements(p_value) e
             where jsonb_typeof(e) <> 'string' or (e #>> '{}') <> all (p_known)) then
    errors := errors || (p_path || ':unknown_value');
  end if;
  if exists (select 1 from jsonb_array_elements(p_value) e
             where jsonb_typeof(e) = 'string' and (e #>> '{}') = any (p_known)
             group by e #>> '{}' having count(*) > 1) then
    errors := errors || (p_path || ':duplicate');
  end if;
  if exists (select 1 from unnest(p_mandatory) m where not (p_value ? m)) then
    errors := errors || (p_path || ':mandatory');
  end if;
  return errors;
end;
$$;

create function private.risk_config_errors(p_config jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  top_keys constant text[] := array['schema', 'signals', 'approveMax', 'rejectMin', 'hardFlags', 'alwaysReviewDocuments', 'autoDecide'];
  setting_keys constant text[] := array['weight', 'enabled'];
  known constant text[] := private.risk_signal_codes();
  errors text[] := '{}';
  signals jsonb;
  setting jsonb;
  code text;
  path text;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    return array[':not_object'];
  end if;
  errors := errors || array(select k || ':unknown_key' from jsonb_object_keys(p_config) k where k <> all (top_keys));
  errors := errors || array(select k || ':missing_key' from unnest(top_keys) k where not (p_config ? k));
  if p_config ? 'schema' and (p_config -> 'schema') is distinct from '2'::jsonb then
    errors := errors || 'schema:schema'::text;
  end if;

  if p_config ? 'signals' then
    signals := p_config -> 'signals';
    if jsonb_typeof(signals) <> 'object' then
      errors := errors || 'signals:not_object'::text;
    else
      errors := errors || array(select 'signals.' || k || ':unknown_key' from jsonb_object_keys(signals) k where k <> all (known));
      errors := errors || array(select 'signals.' || k || ':missing_key' from unnest(known) k where not (signals ? k));
      foreach code in array known loop
        continue when not (signals ? code);
        setting := signals -> code;
        path := 'signals.' || code;
        if jsonb_typeof(setting) <> 'object' then
          errors := errors || (path || ':not_object');
          continue;
        end if;
        errors := errors || array(select path || '.' || k || ':unknown_key' from jsonb_object_keys(setting) k where k <> all (setting_keys));
        errors := errors || array(select path || '.' || k || ':missing_key' from unnest(setting_keys) k where not (setting ? k));
        if setting ? 'weight' then
          errors := errors || private.risk_score_errors(setting -> 'weight', path || '.weight');
        end if;
        if setting ? 'enabled' and jsonb_typeof(setting -> 'enabled') <> 'boolean' then
          errors := errors || (path || '.enabled:not_boolean');
        end if;
      end loop;
    end if;
  end if;

  if p_config ? 'approveMax' then
    errors := errors || private.risk_score_errors(p_config -> 'approveMax', 'approveMax');
  end if;
  if p_config ? 'rejectMin' then
    errors := errors || private.risk_score_errors(p_config -> 'rejectMin', 'rejectMin');
  end if;
  if jsonb_typeof(p_config -> 'approveMax') = 'number' and jsonb_typeof(p_config -> 'rejectMin') = 'number'
     and (p_config ->> 'approveMax')::numeric >= (p_config ->> 'rejectMin')::numeric then
    errors := errors || 'rejectMin:order'::text;
  end if;
  if p_config ? 'hardFlags' then
    errors := errors || private.risk_list_errors(p_config -> 'hardFlags', 'hardFlags', known,
      array['document_expired', 'under_18', 'manual_review_document']);
  end if;
  if p_config ? 'alwaysReviewDocuments' then
    errors := errors || private.risk_list_errors(p_config -> 'alwaysReviewDocuments', 'alwaysReviewDocuments',
      private.risk_declared_documents(), array['cni_legacy', 'residence_permit', 'driving_licence', 'voter_card']);
  end if;
  if p_config ? 'autoDecide' and jsonb_typeof(p_config -> 'autoDecide') <> 'boolean' then
    errors := errors || 'autoDecide:not_boolean'::text;
  end if;
  -- The C collation sorts like JavaScript's default sort (code points), so both give the same list.
  return array(select e from (select distinct e from unnest(errors) e) d order by e collate "C");
end;
$$;

-- The lists in canonical order (normaliseThresholdConfig in risk.ts). For a valid configuration only.
create function private.risk_normalise_config(p_config jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_config || jsonb_build_object(
    'hardFlags', to_jsonb(array(
      select s from unnest(private.risk_signal_codes()) with ordinality t (s, i)
      where p_config -> 'hardFlags' ? s order by i)),
    'alwaysReviewDocuments', to_jsonb(array(
      select d from unnest(private.risk_declared_documents()) with ordinality t (d, i)
      where p_config -> 'alwaysReviewDocuments' ? d order by i)))
$$;

-- What a new version changes, as generic paths (for the audit log). A previous version in another
-- format (version 1) gives ["schema"].
create function private.risk_config_changes(p_from jsonb, p_to jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when (p_from -> 'schema') is distinct from '2'::jsonb then array['schema'] else array(
    select c.path from (
      select 'approveMax' as path, 1 as o, 0::bigint as i where (p_from -> 'approveMax') <> (p_to -> 'approveMax')
      union all
      select 'rejectMin', 2, 0 where (p_from -> 'rejectMin') <> (p_to -> 'rejectMin')
      union all
      select 'autoDecide', 3, 0 where (p_from -> 'autoDecide') <> (p_to -> 'autoDecide')
      union all
      select 'signals.' || s || '.weight', 4, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from #> array['signals', s, 'weight']) is distinct from (p_to #> array['signals', s, 'weight'])
      union all
      select 'signals.' || s || '.enabled', 5, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from #> array['signals', s, 'enabled']) is distinct from (p_to #> array['signals', s, 'enabled'])
      union all
      select 'hardFlags.' || s, 6, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from -> 'hardFlags' ? s) <> (p_to -> 'hardFlags' ? s)
      union all
      select 'alwaysReviewDocuments.' || d, 7, i from unnest(private.risk_declared_documents()) with ordinality t (d, i)
       where (p_from -> 'alwaysReviewDocuments' ? d) <> (p_to -> 'alwaysReviewDocuments' ? d)
    ) c order by c.o, c.i) end
$$;

-- ---------------------------------------------------------------------------
-- Threshold versions: append-only, each one valid, numbered without gaps
-- ---------------------------------------------------------------------------
alter table public.threshold_config
  add constraint threshold_config_why
    check (version = 1 or (note is not null and char_length(btrim(note)) between 5 and 500)),
  -- Version 2 is seeded by this migration; every later one is made by a named admin.
  add constraint threshold_config_who check (version <= 2 or created_by is not null);
create index threshold_config_created_by_idx on public.threshold_config (created_by) where created_by is not null;

create function private.threshold_config_check_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version is distinct from coalesce((select max(tc.version) from public.threshold_config tc), 0) + 1 then
    raise exception 'threshold_config: a new version must follow the latest one' using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(private.risk_config_errors(new.config)) > 0 then
    raise exception 'threshold_config: the configuration is not valid' using errcode = 'invalid_parameter_value';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create function private.threshold_config_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'threshold_config is append-only: add a new version instead';
end;
$$;

create trigger threshold_config_check_insert
  before insert on public.threshold_config
  for each row execute function private.threshold_config_check_insert();
create trigger threshold_config_no_update_delete
  before update or delete on public.threshold_config
  for each row execute function private.threshold_config_immutable();
create trigger threshold_config_no_truncate
  before truncate on public.threshold_config
  for each statement execute function private.threshold_config_immutable();

-- Staff keep reading every version (M0 policy); nobody writes but the functions below.
revoke all on public.threshold_config from anon, authenticated;
grant select on public.threshold_config to authenticated;

-- Version 2: DEFAULT_THRESHOLD_CONFIG in risk.ts (risk.test.ts and 60_m8_test.sql check they are equal).
insert into public.threshold_config (version, config, note) values (
  2,
  '{
     "schema": 2,
     "signals": {
       "document_expired":           {"weight": 1,   "enabled": true},
       "under_18":                   {"weight": 1,   "enabled": true},
       "image_reused":               {"weight": 0.6, "enabled": true},
       "unsupported_document":       {"weight": 0.5, "enabled": true},
       "mrz_disagreement":           {"weight": 0.5, "enabled": true},
       "mrz_invalid_server":         {"weight": 0.5, "enabled": true},
       "mrz_print_mismatch":         {"weight": 0.5, "enabled": true},
       "type_mismatch":              {"weight": 0.3, "enabled": true},
       "date_logic":                 {"weight": 0.4, "enabled": true},
       "number_format":              {"weight": 0.2, "enabled": true},
       "manual_review_document":     {"weight": 0,   "enabled": true},
       "unrecognised_document":      {"weight": 0.3, "enabled": true},
       "mrz_unreadable_server":      {"weight": 0.2, "enabled": true},
       "mrz_phone_flag":             {"weight": 0.1, "enabled": true},
       "phone_report_missing":       {"weight": 0.1, "enabled": true},
       "provisional_classification": {"weight": 0.1, "enabled": true},
       "quality_poor":               {"weight": 0.1, "enabled": true},
       "liveness_flag":              {"weight": 0.5, "enabled": true},
       "face_match_flag":            {"weight": 0.5, "enabled": true}
     },
     "approveMax": 0.15,
     "rejectMin": 0.9,
     "hardFlags": ["document_expired", "under_18", "image_reused", "unsupported_document", "manual_review_document"],
     "alwaysReviewDocuments": ["cni_legacy", "residence_permit", "driving_licence", "voter_card"],
     "autoDecide": false
   }'::jsonb,
  'M8: transparent weighted rules and hard flags (Phase 1). Automatic decisions off: every case is decided by a person.'
);

-- ---------------------------------------------------------------------------
-- The assessment stored on each case, and what each decision was shown
-- ---------------------------------------------------------------------------
alter table public.verification
  add column risk_recommendation public.decision_outcome,
  -- RiskAssessment (risk.ts): generic codes, weights and cut-offs only, never a value read from a document.
  add column risk_reasons jsonb check (risk_reasons is null or jsonb_typeof(risk_reasons) = 'object'),
  add column risk_assessed_at timestamptz;
create index verification_threshold_config_idx on public.verification (threshold_config_version)
  where threshold_config_version is not null;

alter table public.decision
  -- The recommendation, band and score on the case when it was decided (with threshold_config_version).
  add column recommendation public.decision_outcome,
  add column risk_band public.decision_outcome,
  add column risk_score numeric(5, 4) check (risk_score between 0 and 1),
  -- Null when the recommendation was review or missing: only approve and reject can be agreed with.
  add column agrees_with_recommendation boolean,
  add constraint decision_note_length check (note is null or char_length(note) <= 1000);
create index decision_threshold_config_idx on public.decision (threshold_config_version)
  where threshold_config_version is not null;
create index decision_actor_idx on public.decision (actor_id) where actor_id is not null;

-- ---------------------------------------------------------------------------
-- The rules (evaluateRisk in risk.ts)
-- ---------------------------------------------------------------------------
create function private.risk_evaluate(p_facts jsonb, p_config jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  known constant text[] := private.risk_signal_codes();
  firm_codes constant text[] := private.risk_firm_signals();
  required constant text[] := private.risk_required_checks();
  present text[] := array(select distinct jsonb_array_elements_text(coalesce(p_facts -> 'signals', '[]'::jsonb)));
  missing_in text[] := array(select distinct jsonb_array_elements_text(coalesce(p_facts -> 'missing', '[]'::jsonb)));
  declared text := p_facts ->> 'declaredDocument';
  approve_units numeric := (p_config ->> 'approveMax')::numeric * 10000;
  reject_units numeric := (p_config ->> 'rejectMin')::numeric * 10000;
  contributions jsonb := '[]'::jsonb;
  hard text[] := '{}';
  unknown text[];
  missing text[];
  reasons text[] := '{}';
  score_units bigint := 0;
  firm_units bigint := 0;
  first_firm text;
  code text;
  setting jsonb;
  units bigint;
  counted boolean;
  is_firm boolean;
  is_hard boolean;
  always_review boolean;
  recommendation text := 'review';
  band text;
begin
  foreach code in array known loop
    continue when code <> all (present);
    setting := p_config -> 'signals' -> code;
    units := round((setting ->> 'weight')::numeric * 10000);
    counted := (setting ->> 'enabled')::boolean;
    is_firm := code = any (firm_codes);
    is_hard := p_config -> 'hardFlags' ? code;
    contributions := contributions || jsonb_build_array(jsonb_build_object(
      'signal', code, 'weight', setting -> 'weight', 'counted', counted, 'firm', is_firm, 'hard', is_hard));
    if is_hard then
      hard := hard || code;
    end if;
    if counted then
      score_units := score_units + units;
      if is_firm then
        firm_units := firm_units + units;
        if first_firm is null and units > 0 then
          first_firm := code;
        end if;
      end if;
    end if;
  end loop;
  score_units := least(score_units, 10000);
  firm_units := least(firm_units, 10000);

  unknown := array(select p from unnest(present) p where p <> all (known) order by p collate "C");
  missing := array(select r from unnest(required) with ordinality t (r, i) where r = any (missing_in) order by i)
          || array(select m from unnest(missing_in) m where m <> all (required) order by m collate "C");
  always_review := declared is not null and p_config -> 'alwaysReviewDocuments' ? declared;

  if cardinality(hard) > 0 then reasons := reasons || 'hard_flag'::text; end if;
  if cardinality(unknown) > 0 then reasons := reasons || 'unknown_signal'::text; end if;
  if always_review then reasons := reasons || 'always_review_document'::text; end if;
  if firm_units >= reject_units then reasons := reasons || 'firm_score_high'::text; end if;
  if score_units >= reject_units and firm_units < reject_units then reasons := reasons || 'provisional_signals'::text; end if;
  if score_units > approve_units and score_units < reject_units then reasons := reasons || 'score_between'::text; end if;
  if score_units <= approve_units then reasons := reasons || 'score_low'::text; end if;
  if cardinality(missing) > 0 then reasons := reasons || 'missing_checks'::text; end if;

  if cardinality(hard) > 0 or cardinality(unknown) > 0 or always_review then
    recommendation := 'review';
  elsif firm_units >= reject_units then
    recommendation := 'reject';
  elsif score_units <= approve_units and cardinality(missing) = 0 then
    recommendation := 'approve';
  end if;
  band := case when score_units <= approve_units then 'approve' when score_units >= reject_units then 'reject' else 'review' end;

  return jsonb_build_object(
    'recommendation', recommendation,
    'band', band,
    'score', trim_scale(score_units::numeric / 10000),
    'firmScore', trim_scale(firm_units::numeric / 10000),
    'reasons', to_jsonb(reasons),
    'contributions', contributions,
    'hardFlags', to_jsonb(hard),
    'missing', to_jsonb(missing),
    'unknownSignals', to_jsonb(unknown),
    'rejectReasonCode', case when recommendation = 'reject' then private.risk_reject_code(first_firm) end,
    'approveMax', p_config -> 'approveMax',
    'rejectMin', p_config -> 'rejectMin');
end;
$$;

-- ---------------------------------------------------------------------------
-- What a case shows (RiskFacts in risk.ts): generic codes only
-- ---------------------------------------------------------------------------
-- Signals: the document_policy reasons (server_unchecked becomes the missing check server_checks); on
-- the newest live photo of each side the declared document needs: a photo also uploaded in another
-- verification (image_reused), the phone's report of the code lines flagged (mrz_phone_flag), a server
-- quality verdict other than ok (quality_poor); and the placeholder checks of M6 and M7 when they ran
-- and did not pass. Missing: a side without a server result (server_checks), and the liveness and face
-- match checks until they exist. Null for an unknown case.
create function private.risk_facts(p_verification uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  declared text;
  required text[];
  reasons text[];
  signals text[] := '{}';
  missing text[] := '{}';
  placeholder public.check_result;
  placeholder_name text;
begin
  select v.declared_document into declared from public.verification v where v.id = p_verification;
  if not found then
    return null;
  end if;
  -- REQUIRED_SIDES in contract.ts: the passport's photo page only, both sides of every card.
  required := case when declared is null then '{}'::text[]
                   when declared = 'passport' then array['document_front']
                   else array['document_front', 'document_back'] end;

  reasons := coalesce((
    select array(select jsonb_array_elements_text(coalesce(cr.details -> 'reasons', '[]'::jsonb)))
      from public.check_result cr
     where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'document_policy'), '{}');
  signals := signals || array(select r from unnest(reasons) r where r <> 'server_unchecked');
  if 'server_unchecked' = any (reasons) or declared is null or exists (
       select 1 from unnest(required) k
       where not exists (
         select 1 from private.worker_newest_captures(p_verification) n
         join public.check_result q on q.capture_id = n.capture_id and q.check_name = 'quality_server'
         where n.kind::text = k)) then
    missing := missing || 'server_checks'::text;
  end if;

  if exists (select 1 from private.worker_newest_captures(p_verification) n
             join public.capture c on c.id = n.capture_id
             where n.kind::text = any (required) and c.quality -> 'server' ->> 'reusedElsewhere' = 'true') then
    signals := signals || 'image_reused'::text;
  end if;
  if exists (select 1 from private.worker_newest_captures(p_verification) n
             join public.check_result m on m.capture_id = n.capture_id and m.check_name = 'mrz'
             where n.kind::text = any (required) and m.outcome <> 'pass') then
    signals := signals || 'mrz_phone_flag'::text;
  end if;
  if exists (select 1 from private.worker_newest_captures(p_verification) n
             join public.check_result q on q.capture_id = n.capture_id and q.check_name = 'quality_server'
             where n.kind::text = any (required) and coalesce(q.details ->> 'verdict', '') <> 'ok') then
    signals := signals || 'quality_poor'::text;
  end if;

  -- Placeholders: PLACEHOLDER_CHECK_NAMES in risk.ts. The newest result of each, whatever it ran on.
  foreach placeholder_name in array array['liveness', 'face_match'] loop
    select * into placeholder from public.check_result cr
     where cr.verification_id = p_verification and cr.check_name = placeholder_name
     order by cr.created_at desc, cr.id desc limit 1;
    if not found then
      missing := missing || placeholder_name;
    elsif placeholder.outcome <> 'pass' then
      signals := signals || (placeholder_name || '_flag');
    end if;
  end loop;

  return jsonb_build_object(
    'declaredDocument', declared,
    'signals', to_jsonb(array(select d.s from (select distinct s from unnest(signals) s) d order by d.s collate "C")),
    'missing', to_jsonb(array(select d.m from (select distinct m from unnest(missing) m) d order by d.m collate "C")));
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording a decision (staff, or the system when automatic decisions are on)
-- ---------------------------------------------------------------------------
-- {result: 'ok' | 'not_found' | 'already_decided' | 'not_submitted', decisionId, status, recommendation,
-- agreesWithRecommendation, thresholdVersion}. Closes the case's review task and audits, all together.
-- The note never goes into the audit log (only whether there is one).
create function private.record_decision(
  p_verification uuid,
  p_actor_type public.actor_type,
  p_actor uuid,
  p_role text,
  p_outcome public.decision_outcome,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.verification;
  decision_id uuid;
  agrees boolean;
  new_status public.verification_status;
begin
  if p_outcome not in ('approve', 'reject') then
    raise exception 'record_decision: a decision approves or rejects' using errcode = 'invalid_parameter_value';
  end if;
  select * into v from public.verification vv where vv.id = p_verification for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v.status in ('approved', 'rejected') then
    return jsonb_build_object('result', 'already_decided');
  end if;
  if v.status <> 'submitted' then
    return jsonb_build_object('result', 'not_submitted');
  end if;

  agrees := case when v.risk_recommendation in ('approve', 'reject') then v.risk_recommendation = p_outcome end;
  new_status := case p_outcome when 'approve' then 'approved' else 'rejected' end;
  insert into public.decision (
    verification_id, actor_type, actor_id, outcome, reason_code, note, threshold_config_version,
    recommendation, risk_band, risk_score, agrees_with_recommendation)
  values (
    p_verification, p_actor_type, p_actor, p_outcome, p_reason_code, p_note, v.threshold_config_version,
    v.risk_recommendation, (v.risk_reasons ->> 'band')::public.decision_outcome, v.risk_score, agrees)
  returning id into decision_id;

  update public.verification vv set status = new_status, decided_at = now() where vv.id = p_verification;
  update public.review_task rt set status = 'done', closed_at = now()
   where rt.verification_id = p_verification and rt.status in ('open', 'assigned');

  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values (p_actor_type, p_actor::text, 'decision.create', 'verification', p_verification::text,
          jsonb_build_object(
            'decisionId', decision_id, 'outcome', p_outcome, 'reasonCode', p_reason_code,
            'automatic', p_actor_type = 'system', 'role', p_role, 'hasNote', p_note is not null,
            'recommendation', v.risk_recommendation, 'agreesWithRecommendation', agrees,
            'thresholdVersion', v.threshold_config_version, 'riskScore', v.risk_score));

  return jsonb_build_object(
    'result', 'ok', 'decisionId', decision_id, 'status', new_status, 'recommendation', v.risk_recommendation,
    'agreesWithRecommendation', agrees, 'thresholdVersion', v.threshold_config_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Assessing a case
-- ---------------------------------------------------------------------------
-- Assesses a submitted, undecided case with the active version and stores the result when it changed
-- (audited as risk.assess). With automatic decisions on, decides a test session whose recommendation is
-- reject, or approve with no required check missing. True when the stored assessment changed.
create function private.risk_refresh(p_verification uuid, p_trigger text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v public.verification;
  cfg public.threshold_config;
  facts jsonb;
  result jsonb;
  score numeric;
  recommendation public.decision_outcome;
  changed boolean := false;
begin
  -- The row first, then everything else in later statements, which therefore see what the holder of
  -- the lock committed (a concurrent submit, worker result or new threshold version).
  select * into v from public.verification vv where vv.id = p_verification for no key update;
  if not found or v.status <> 'submitted' then
    return false;
  end if;
  select * into cfg from public.threshold_config tc order by tc.version desc limit 1;
  if not found or cardinality(private.risk_config_errors(cfg.config)) > 0 then
    raise exception 'risk_refresh: the active threshold version is not valid';
  end if;

  facts := private.risk_facts(p_verification);
  result := private.risk_evaluate(facts, cfg.config);
  score := (result ->> 'score')::numeric;
  recommendation := (result ->> 'recommendation')::public.decision_outcome;

  if v.risk_reasons is distinct from result or v.risk_score is distinct from score
     or v.risk_recommendation is distinct from recommendation or v.threshold_config_version is distinct from cfg.version then
    update public.verification vv
       set risk_score = score, risk_recommendation = recommendation, risk_reasons = result,
           threshold_config_version = cfg.version, risk_assessed_at = now()
     where vv.id = p_verification;
    insert into public.audit_event (actor_type, action, target_type, target_id, details)
    values ('system', 'risk.assess', 'verification', p_verification::text,
            jsonb_build_object('thresholdVersion', cfg.version, 'score', score, 'recommendation', recommendation,
                               'band', result ->> 'band', 'trigger', p_trigger));
    changed := true;
  end if;

  -- Automatic decisions: off by default; test sessions only; never an approval with a check missing.
  if (cfg.config ->> 'autoDecide')::boolean and v.is_test
     and (recommendation = 'reject'
          or (recommendation = 'approve' and jsonb_array_length(facts -> 'missing') = 0)) then
    perform private.record_decision(p_verification, 'system', null, null, recommendation,
      case when recommendation = 'reject' then result ->> 'rejectReasonCode' end, null);
  end if;
  return changed;
end;
$$;

-- As risk_refresh, but a failure never fails the caller's transaction (a worker result, a submit, a
-- new threshold version): the stored assessment is cleared, so the dashboard shows the case as not
-- assessed rather than a stale recommendation, and the failure is audited. Staff decide every case anyway.
create function private.risk_refresh_safe(p_verification uuid, p_trigger text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  return private.risk_refresh(p_verification, p_trigger);
exception when others then
  update public.verification vv
     set risk_score = null, risk_recommendation = null, risk_reasons = null, risk_assessed_at = null
   where vv.id = p_verification and vv.status = 'submitted';
  insert into public.audit_event (actor_type, action, target_type, target_id, details)
  values ('system', 'risk.assess_failed', 'verification', p_verification::text,
          jsonb_build_object('trigger', p_trigger, 'sqlstate', sqlstate));
  return false;
end;
$$;

-- At submit, and whenever a check of the case changes. Deferred: they run as the transaction commits,
-- once its writes are all done (worker_apply_case writes several rows in turn). SECURITY DEFINER: they
-- read threshold_config and write the verification and the audit log, whoever wrote the check.
create function private.risk_after_submit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.risk_refresh_safe(new.id, 'submit');
  return null;
end;
$$;

create function private.risk_after_check_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.risk_refresh_safe(old.verification_id, 'checks');
  else
    perform private.risk_refresh_safe(new.verification_id, 'checks');
  end if;
  return null;
end;
$$;

create constraint trigger risk_after_submit
  after update of status on public.verification
  deferrable initially deferred
  for each row
  when (new.status = 'submitted' and old.status is distinct from 'submitted')
  execute function private.risk_after_submit();

create constraint trigger risk_after_check_change
  after insert or update or delete on public.check_result
  deferrable initially deferred
  for each row
  execute function private.risk_after_check_change();

-- ---------------------------------------------------------------------------
-- Staff RPCs (called by the `admin` Edge Function, service role)
-- ---------------------------------------------------------------------------
-- A staff decision. The access rule of the admin function is checked again here: active staff whose
-- role matches p_role, reviewer or supervisor (never admin), and a reviewer only while the case is
-- assigned to them. {result: 'ok' | 'not_found' | 'already_decided' | 'not_submitted' | 'note_required' |
-- 'invalid_reason', ...}: a reject needs an active rider reason, an approval none; a note is required
-- when the decision goes against the recommendation, when approving a case with a hard flag, and when
-- the case has no assessment.
create function public.staff_decide(
  p_verification uuid,
  p_actor uuid,
  p_role text,
  p_outcome text,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.verification;
  note text := nullif(btrim(p_note), '');
begin
  if p_role is null or p_role not in ('reviewer', 'supervisor')
     or not exists (
       select 1 from public.staff_profile sp
       where sp.user_id = p_actor and sp.active and sp.role::text = p_role)
     or (p_role = 'reviewer' and not exists (
       select 1 from public.review_task rt
       where rt.verification_id = p_verification and rt.assigned_to = p_actor and rt.status = 'assigned')) then
    raise exception 'staff_decide: not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_outcome is null or p_outcome not in ('approve', 'reject') then
    raise exception 'staff_decide: a decision approves or rejects' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(note) > 1000 then
    raise exception 'staff_decide: the note is too long' using errcode = 'invalid_parameter_value';
  end if;
  if (p_outcome = 'approve' and p_reason_code is not null)
     or (p_outcome = 'reject' and not exists (
       select 1 from public.reason_code rc where rc.code = p_reason_code and rc.active)) then
    return jsonb_build_object('result', 'invalid_reason');
  end if;

  select * into v from public.verification vv where vv.id = p_verification for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v.status = 'submitted' and note is null and (
       v.risk_recommendation is null
       or (v.risk_recommendation in ('approve', 'reject') and v.risk_recommendation::text <> p_outcome)
       or (p_outcome = 'approve' and jsonb_array_length(coalesce(v.risk_reasons -> 'hardFlags', '[]'::jsonb)) > 0)) then
    return jsonb_build_object('result', 'note_required');
  end if;
  return private.record_decision(p_verification, 'staff', p_actor, p_role, p_outcome::public.decision_outcome,
                                 p_reason_code, note);
end;
$$;

-- A new threshold version, by an active admin. {result: 'created', version, rescored} | {result: 'stale',
-- version} (the active version is no longer p_base_version) | {result: 'invalid', errors} | {result:
-- 'invalid_note'} | {result: 'unchanged'}. The new version is active at once: every submitted, undecided
-- case is assessed again with it, in the same transaction.
create function public.staff_create_threshold_version(
  p_actor uuid,
  p_base_version integer,
  p_config jsonb,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur public.threshold_config;
  errors text[];
  note text := btrim(p_note);
  config jsonb;
  next_version integer;
  rescored integer := 0;
  case_id uuid;
begin
  if not exists (select 1 from public.staff_profile sp where sp.user_id = p_actor and sp.active and sp.role = 'admin') then
    raise exception 'staff_create_threshold_version: not allowed' using errcode = 'insufficient_privilege';
  end if;
  -- One new version at a time.
  perform pg_advisory_xact_lock(hashtextextended('threshold_config', 0));
  select * into cur from public.threshold_config tc order by tc.version desc limit 1;
  if p_base_version is distinct from cur.version then
    return jsonb_build_object('result', 'stale', 'version', cur.version);
  end if;
  errors := private.risk_config_errors(p_config);
  if cardinality(errors) > 0 then
    return jsonb_build_object('result', 'invalid', 'errors', to_jsonb(errors));
  end if;
  if note is null or char_length(note) not between 5 and 500 then
    return jsonb_build_object('result', 'invalid_note');
  end if;
  config := private.risk_normalise_config(p_config);
  if cardinality(private.risk_config_errors(cur.config)) = 0 and config = private.risk_normalise_config(cur.config) then
    return jsonb_build_object('result', 'unchanged');
  end if;

  next_version := cur.version + 1;
  insert into public.threshold_config (version, config, note, created_by) values (next_version, config, note, p_actor);
  -- Which settings changed, never the note (free text).
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('staff', p_actor::text, 'threshold_config.create', 'threshold_config', next_version::text,
          jsonb_build_object('version', next_version, 'baseVersion', cur.version,
                             'changes', to_jsonb(private.risk_config_changes(cur.config, config))));

  for case_id in
    select vv.id from public.verification vv where vv.status = 'submitted' order by vv.submitted_at, vv.id
  loop
    if private.risk_refresh_safe(case_id, 'thresholds') then
      rescored := rescored + 1;
    end if;
  end loop;
  return jsonb_build_object('result', 'created', 'version', next_version, 'rescored', rescored);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the RPCs are for the service role only; the private helpers for nobody but their owner
-- ---------------------------------------------------------------------------
revoke execute on function private.risk_signal_codes() from public;
revoke execute on function private.risk_firm_signals() from public;
revoke execute on function private.risk_required_checks() from public;
revoke execute on function private.risk_declared_documents() from public;
revoke execute on function private.risk_reject_code(text) from public;
revoke execute on function private.risk_score_errors(jsonb, text) from public;
revoke execute on function private.risk_list_errors(jsonb, text, text[], text[]) from public;
revoke execute on function private.risk_config_errors(jsonb) from public;
revoke execute on function private.risk_normalise_config(jsonb) from public;
revoke execute on function private.risk_config_changes(jsonb, jsonb) from public;
revoke execute on function private.threshold_config_check_insert() from public;
revoke execute on function private.threshold_config_immutable() from public;
revoke execute on function private.risk_evaluate(jsonb, jsonb) from public;
revoke execute on function private.risk_facts(uuid) from public;
revoke execute on function private.record_decision(uuid, public.actor_type, uuid, text, public.decision_outcome, text, text) from public;
revoke execute on function private.risk_refresh(uuid, text) from public;
revoke execute on function private.risk_refresh_safe(uuid, text) from public;
revoke execute on function private.risk_after_submit() from public;
revoke execute on function private.risk_after_check_change() from public;

revoke execute on function public.staff_decide(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.staff_create_threshold_version(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.staff_decide(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.staff_create_threshold_version(uuid, integer, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Cases already submitted (test sessions so far) get their first assessment with version 2.
-- ---------------------------------------------------------------------------
do $$
declare
  case_id uuid;
begin
  for case_id in select vv.id from public.verification vv where vv.status = 'submitted' order by vv.submitted_at, vv.id loop
    perform private.risk_refresh_safe(case_id, 'migration');
  end loop;
end $$;
