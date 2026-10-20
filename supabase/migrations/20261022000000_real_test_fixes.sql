-- Confiance Verify — fixes after the PM's first real test (2026-10-20, a test session with the PM's own
-- new CNI and face, on a low-end phone). docs/PLAN.md, "Decisions after the first real test".
--   * Printed text vs code lines: printed text is read by OCR, which is not tuned on real cards, so a
--     printed NAME that differs from the code lines is no longer a firm signal. When the code lines are
--     trustworthy (the server read them with every check digit right, the phone read them too and the
--     two agree), it is the new provisional signal print_name_mismatch (weight 0 unless an admin sets
--     one): a note for staff that never blocks an automatic approval. A differing document number or
--     date stays mrz_print_mismatch (firm). private.risk_facts applies this to the consistency results
--     stored before the fix (name in flags) and after it (name in provisional).
--   * print_name_mismatch is an OPTIONAL signal in a threshold configuration: the versions stored before
--     it lack it and give it its default (private.risk_optional_signal_defaults, risk.ts
--     OPTIONAL_SIGNAL_DEFAULTS). A new threshold version writes it out, made by this migration with the
--     reason "Fixes after the PM's first real test"; like any new version, it re-assesses every case
--     waiting for a decision (none is approved by a migration's re-assessment).
--   * Liveness (face/decide.ts liveness-eval-v2): its details may carry `metrics` (the generic
--     per-frame angles and scores the decision used, for tuning: never a landmark or a pixel), and the
--     timing of both face checks may carry fetchMs, wallMs and sinceJobMs (the 10-second target).
--     public.face_job_context gives the job's creation time for sinceJobMs.
-- Nothing is removed, and the text holds no removal statement (docs/HANDOFF.md).

-- ---------------------------------------------------------------------------
-- Signals: print_name_mismatch, optional in a configuration
-- ---------------------------------------------------------------------------
-- The same list, in the same order, as RISK_SIGNALS in risk.ts.
create or replace function private.risk_signal_codes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'document_expired', 'under_18', 'image_reused', 'unsupported_document', 'mrz_disagreement',
    'mrz_invalid_server', 'mrz_print_mismatch', 'type_mismatch', 'date_logic', 'number_format',
    'manual_review_document', 'print_name_mismatch', 'unrecognised_document', 'mrz_unreadable_server',
    'mrz_phone_flag', 'phone_report_missing', 'provisional_classification', 'quality_poor', 'liveness_flag',
    'face_match_flag']
$$;

-- Signals a configuration may leave out, with the setting they then take (OPTIONAL_SIGNAL_DEFAULTS).
create function private.risk_optional_signal_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"print_name_mismatch": {"weight": 0, "enabled": true}}'::jsonb
$$;

-- As in the automatic-approval migration, but an optional signal may be missing (thresholdConfigErrors).
create or replace function private.risk_config_errors(p_config jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  top_keys constant text[] := array['schema', 'signals', 'approveMax', 'rejectMin', 'hardFlags', 'alwaysReviewDocuments', 'autoDecide'];
  optional_keys constant text[] := array['faceMatchCountsForApproval'];
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
  errors := errors || array(select k || ':unknown_key' from jsonb_object_keys(p_config) k
                             where k <> all (top_keys) and k <> all (optional_keys));
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
      -- An optional signal (private.risk_optional_signal_defaults) may be left out.
      errors := errors || array(select 'signals.' || k || ':missing_key' from unnest(known) k
                                 where not (signals ? k) and not (private.risk_optional_signal_defaults() ? k));
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
  if p_config ? 'faceMatchCountsForApproval' and jsonb_typeof(p_config -> 'faceMatchCountsForApproval') <> 'boolean' then
    errors := errors || 'faceMatchCountsForApproval:not_boolean'::text;
  end if;
  -- The C collation sorts like JavaScript's default sort (code points), so both give the same list.
  return array(select e from (select distinct e from unnest(errors) e) d order by e collate "C");
end;
$$;


-- Every signal written out, an optional one a version left out with its default (normaliseThresholdConfig).
create or replace function private.risk_normalise_config(p_config jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_config || jsonb_build_object(
    -- Every signal written out: an optional one a version left out gets its default.
    'signals', private.risk_optional_signal_defaults() || (p_config -> 'signals'),
    'hardFlags', to_jsonb(array(
      select s from unnest(private.risk_signal_codes()) with ordinality t (s, i)
      where p_config -> 'hardFlags' ? s order by i)),
    'alwaysReviewDocuments', to_jsonb(array(
      select d from unnest(private.risk_declared_documents()) with ordinality t (d, i)
      where p_config -> 'alwaysReviewDocuments' ? d order by i)),
    'faceMatchCountsForApproval', private.risk_face_match_counts(p_config))
$$;


-- ---------------------------------------------------------------------------
-- The rules (evaluateRisk): an optional signal a version leaves out takes its default setting
-- ---------------------------------------------------------------------------
create or replace function private.risk_evaluate(p_facts jsonb, p_config jsonb)
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
  review_only_in text[] := array(select distinct jsonb_array_elements_text(coalesce(p_facts -> 'reviewOnly', '[]'::jsonb)));
  declared text := p_facts ->> 'declaredDocument';
  document_firm boolean := coalesce(p_facts -> 'documentFirm' = 'true'::jsonb, false);
  test_session boolean := coalesce(p_facts -> 'testSession' = 'true'::jsonb, false);
  face_counts boolean := private.risk_face_match_counts(p_config);
  approve_units numeric := (p_config ->> 'approveMax')::numeric * 10000;
  reject_units numeric := (p_config ->> 'rejectMin')::numeric * 10000;
  contributions jsonb := '[]'::jsonb;
  hard text[] := '{}';
  unknown text[];
  missing text[];
  uncalibrated text[];
  review_only text[];
  counted_uncalibrated text[];
  reasons text[] := '{}';
  blockers text[] := '{}';
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
    setting := coalesce(p_config -> 'signals' -> code, private.risk_optional_signal_defaults() -> code);
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
  uncalibrated := array(select r from unnest(required) with ordinality t (r, i) where r = any (review_only_in) order by i)
               || array(select m from unnest(review_only_in) m where m <> all (required) order by m collate "C");
  counted_uncalibrated := array(select u from unnest(uncalibrated) with ordinality t (u, i)
                                 where face_counts and u = 'face_match' order by i);
  review_only := array(select u from unnest(uncalibrated) with ordinality t (u, i)
                        where u <> all (counted_uncalibrated) order by i);
  always_review := declared is not null and p_config -> 'alwaysReviewDocuments' ? declared;

  if cardinality(hard) > 0 then reasons := reasons || 'hard_flag'::text; end if;
  if cardinality(unknown) > 0 then reasons := reasons || 'unknown_signal'::text; end if;
  if always_review then reasons := reasons || 'always_review_document'::text; end if;
  if firm_units >= reject_units then reasons := reasons || 'firm_score_high'::text; end if;
  if score_units >= reject_units and firm_units < reject_units then reasons := reasons || 'provisional_signals'::text; end if;
  if score_units > approve_units and score_units < reject_units then reasons := reasons || 'score_between'::text; end if;
  if score_units <= approve_units then reasons := reasons || 'score_low'::text; end if;
  if cardinality(missing) > 0 then reasons := reasons || 'missing_checks'::text; end if;
  if cardinality(review_only) > 0 then reasons := reasons || 'review_only_check'::text; end if;

  if cardinality(hard) > 0 or cardinality(unknown) > 0 or always_review then
    recommendation := 'review';
  elsif firm_units >= reject_units then
    recommendation := 'reject';
  elsif score_units <= approve_units and cardinality(missing) = 0 and cardinality(review_only) = 0 then
    recommendation := 'approve';
  end if;
  band := case when score_units <= approve_units then 'approve' when score_units >= reject_units then 'reject' else 'review' end;

  -- Automatic approval: every blocker that holds, in the order of AUTO_APPROVAL_BLOCKERS.
  if not coalesce(p_config -> 'autoDecide' = 'true'::jsonb, false) then blockers := blockers || 'auto_decide_off'::text; end if;
  if not test_session then blockers := blockers || 'real_session'::text; end if;
  if recommendation <> 'approve' then blockers := blockers || 'not_recommended'::text; end if;
  if not document_firm then blockers := blockers || 'document_not_firm'::text; end if;
  if 'document_expired' = any (present) then blockers := blockers || 'document_expired'::text; end if;
  if 'under_18' = any (present) then blockers := blockers || 'under_18'::text; end if;
  if 'mrz_print_mismatch' = any (present) then blockers := blockers || 'mrz_print_mismatch'::text; end if;
  if cardinality(hard) > 0 then blockers := blockers || 'hard_flag'::text; end if;
  if present && firm_codes then blockers := blockers || 'firm_signal'::text; end if;
  if cardinality(unknown) > 0 then blockers := blockers || 'unknown_signal'::text; end if;
  if 'quality_poor' = any (present) or 'server_checks' = any (missing) then blockers := blockers || 'quality_not_ok'::text; end if;
  if 'liveness_flag' = any (present) or 'liveness' = any (missing) then blockers := blockers || 'liveness_not_passed'::text; end if;
  if 'face_match_flag' = any (present) or 'face_match' = any (missing) then blockers := blockers || 'face_match_not_passed'::text; end if;
  if not face_counts then blockers := blockers || 'face_match_not_counted'::text; end if;
  if score_units > approve_units then blockers := blockers || 'score_above_cutoff'::text; end if;

  return jsonb_build_object(
    'recommendation', recommendation,
    'band', band,
    'score', trim_scale(score_units::numeric / 10000),
    'firmScore', trim_scale(firm_units::numeric / 10000),
    'reasons', to_jsonb(reasons),
    'contributions', contributions,
    'hardFlags', to_jsonb(hard),
    'missing', to_jsonb(missing),
    'reviewOnly', to_jsonb(review_only),
    'uncalibratedCounted', to_jsonb(counted_uncalibrated),
    'autoApproval', jsonb_build_object('eligible', cardinality(blockers) = 0, 'blockers', to_jsonb(blockers)),
    'unknownSignals', to_jsonb(unknown),
    'rejectReasonCode', case when recommendation = 'reject' then private.risk_reject_code(first_firm) end,
    'approveMax', p_config -> 'approveMax',
    'rejectMin', p_config -> 'rejectMin');
end;
$$;


-- ---------------------------------------------------------------------------
-- What a case shows (RiskFacts): a printed name that differs is a note when the code lines are firm
-- ---------------------------------------------------------------------------
create or replace function private.risk_facts(p_verification uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  declared text;
  test_session boolean;
  required text[];
  mrz_side text;
  reasons text[];
  signals text[] := '{}';
  missing text[] := '{}';
  review_only text[] := '{}';
  document_firm boolean := false;
  placeholder public.check_result;
  placeholder_name text;
  consistency jsonb;
  name_only boolean;
  mrz_agree boolean;
begin
  select v.declared_document, v.is_test into declared, test_session from public.verification v where v.id = p_verification;
  if not found then
    return null;
  end if;
  -- REQUIRED_SIDES in contract.ts: the passport's photo page only, both sides of every card.
  required := case when declared is null then '{}'::text[]
                   when declared = 'passport' then array['document_front']
                   else array['document_front', 'document_back'] end;
  -- MRZ_EXPECTATION in contract.ts, the documents whose code lines are required.
  mrz_side := case declared when 'passport' then 'document_front' when 'cni_biometric' then 'document_back' end;

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

  -- M6 and M7: the case-level checks the face worker's results write (one each per case).
  foreach placeholder_name in array array['liveness', 'face_match'] loop
    select * into placeholder from public.check_result cr
     where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = placeholder_name;
    if not found then
      missing := missing || placeholder_name;
    else
      if placeholder.outcome <> 'pass' then
        signals := signals || (placeholder_name || '_flag');
      end if;
      -- Uncalibrated (M7): listed here; the threshold version decides whether it may count
      -- (faceMatchCountsForApproval, private.risk_evaluate).
      if placeholder_name = 'face_match' and private.face_match_review_only() then
        review_only := review_only || 'face_match'::text;
      end if;
    end if;
  end loop;

  document_firm := mrz_side is not null
    and exists (select 1 from private.worker_newest_captures(p_verification) n
                join public.check_result m on m.capture_id = n.capture_id and m.check_name = 'mrz_server'
                where n.kind::text = mrz_side and m.outcome = 'pass')
    and exists (select 1 from public.check_result cr
                where cr.verification_id = p_verification and cr.capture_id is null
                  and cr.check_name = 'classification' and cr.outcome = 'pass')
    and exists (select 1 from public.check_result cr
                where cr.verification_id = p_verification and cr.capture_id is null
                  and cr.check_name = 'consistency' and cr.details ->> 'basis' = 'mrz');

  -- Fixes after the PM's first real test (2026-10-20): printed text is read by OCR, so a printed NAME
  -- that differs from the code lines is a provisional note (print_name_mismatch, weight 0 by default),
  -- never a firm signal, when the code lines themselves are trustworthy: the server read them with
  -- every check digit right on the newest photo of their side, the phone read them too (its report
  -- passed) and the two readings agree (no mrz_disagreement). Otherwise it stays mrz_print_mismatch
  -- (firm). A differing number or date (mismatches other than "name") always stays firm. Applies to
  -- results stored before this rule (the name in consistency.flags) and after it (in provisional).
  select cr.details into consistency from public.check_result cr
   where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'consistency';
  name_only := coalesce(consistency -> 'mismatches' = '["name"]'::jsonb, false)
    and coalesce(consistency -> 'flags' ? 'mrz_print_mismatch' or consistency -> 'provisional' ? 'mrz_print_mismatch', false);
  if name_only then
    mrz_agree := mrz_side is not null
      and 'mrz_disagreement' <> all (signals)
      and exists (select 1 from private.worker_newest_captures(p_verification) n
                  join public.check_result m on m.capture_id = n.capture_id and m.check_name = 'mrz_server'
                  where n.kind::text = mrz_side and m.outcome = 'pass')
      and exists (select 1 from private.worker_newest_captures(p_verification) n
                  join public.check_result m on m.capture_id = n.capture_id and m.check_name = 'mrz'
                  where n.kind::text = mrz_side and m.outcome = 'pass');
    signals := array_remove(signals, 'mrz_print_mismatch')
            || case when mrz_agree then 'print_name_mismatch' else 'mrz_print_mismatch' end;
  end if;

  return jsonb_build_object(
    'declaredDocument', declared,
    'signals', to_jsonb(array(select d.s from (select distinct s from unnest(signals) s) d order by d.s collate "C")),
    'missing', to_jsonb(array(select d.m from (select distinct m from unnest(missing) m) d order by d.m collate "C")),
    'reviewOnly', to_jsonb(review_only),
    'documentFirm', document_firm,
    'testSession', coalesce(test_session, false));
end;
$$;


-- ---------------------------------------------------------------------------
-- Face checks: liveness-eval-v2 details (metrics) and timings (fetchMs, wallMs, sinceJobMs)
-- ---------------------------------------------------------------------------
-- A face check's timing (LivenessTiming in contract.ts): ms and cold always; fetchMs, wallMs and
-- sinceJobMs when the worker and the function know them. Numbers and one boolean, nothing else.
create function private.face_timing_valid(p_timing jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_timing) = 'object'
     and p_timing ? 'ms' and p_timing ? 'cold'
     and jsonb_typeof(p_timing -> 'cold') = 'boolean'
     and not exists (
       select 1 from jsonb_each(p_timing) e
        where e.key not in ('ms', 'cold', 'fetchMs', 'wallMs', 'sinceJobMs')
           or (e.key <> 'cold' and jsonb_typeof(e.value) <> 'number'))
$$;

-- The generic per-frame numbers of a liveness decision (LivenessMetrics in contract.ts): the rider's
-- neutral, the frames each action was judged on, and per frame its angles and scores. Never a landmark.
create function private.liveness_metrics_valid(p_metrics jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_metrics) = 'object'
     and array(select k from jsonb_object_keys(p_metrics) k order by k collate "C") = array['baseline', 'frames', 'windows']
     and jsonb_typeof(p_metrics -> 'baseline') = 'object'
     and array(select k from jsonb_object_keys(p_metrics -> 'baseline') k order by k collate "C")
         = array['eyeOpenness', 'mouthWidth', 'pitch', 'smile', 'yaw']
     and not exists (select 1 from jsonb_each(p_metrics -> 'baseline') e where jsonb_typeof(e.value) not in ('number', 'null'))
     and jsonb_typeof(p_metrics -> 'frames') = 'array'
     and jsonb_array_length(p_metrics -> 'frames') <= 16
     and not exists (
       select 1 from jsonb_array_elements(p_metrics -> 'frames') f
        where jsonb_typeof(f) <> 'object'
           or array(select k from jsonb_object_keys(f) k order by k collate "C")
              <> array['blink', 'eyeOpenness', 'faces', 'index', 'mouthWidth', 'pitch', 'smile', 'step', 'yaw']
           or exists (select 1 from jsonb_each(f) e where jsonb_typeof(e.value) not in ('number', 'null')))
     and jsonb_typeof(p_metrics -> 'windows') = 'array'
     and jsonb_array_length(p_metrics -> 'windows') <= 5
     and not exists (
       select 1 from jsonb_array_elements(p_metrics -> 'windows') w
        where jsonb_typeof(w) <> 'array' or jsonb_array_length(w) > 16
           or exists (select 1 from jsonb_array_elements(w) i where jsonb_typeof(i) <> 'number'))
$$;

-- As in M6/M7 (the exact keys, codes and fixed values), plus: a liveness result may carry `metrics`
-- (liveness-eval-v2), and both checks' timing may carry fetchMs, wallMs and sinceJobMs.
create or replace function private.face_details_valid(p_check text, p_details jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  keys text[];
begin
  if jsonb_typeof(p_details) is distinct from 'object' then
    return false;
  end if;
  keys := array(select k from jsonb_object_keys(p_details) k order by k collate "C");
  if p_check = 'liveness' then
    return (keys = array['actions', 'challengeId', 'engine', 'evaluated', 'flatPlane', 'flatPlaneScore', 'frames',
                         'framesWithFace', 'problems', 'provisional', 'timing']
            or (keys = array['actions', 'challengeId', 'engine', 'evaluated', 'flatPlane', 'flatPlaneScore', 'frames', 'framesWithFace', 'metrics', 'problems', 'provisional', 'timing']
                and private.liveness_metrics_valid(p_details -> 'metrics')))
       and p_details -> 'evaluated' = 'true'::jsonb and p_details -> 'provisional' = 'true'::jsonb
       and p_details ->> 'flatPlane' in ('depth', 'flat', 'not_measured')
       and jsonb_typeof(p_details -> 'actions') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'actions') a
          where jsonb_typeof(a) <> 'object'
             or array(select k from jsonb_object_keys(a) k order by k collate "C") <> array['action', 'framesWithFace', 'peak', 'result']
             or a ->> 'action' not in ('turn_left', 'turn_right', 'look_up', 'blink', 'smile')
             or a ->> 'result' not in ('pass', 'fail', 'unclear'))
       and jsonb_typeof(p_details -> 'problems') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'problems') p
          where jsonb_typeof(p) <> 'string'
             or p #>> '{}' not in ('action_not_done', 'wrong_direction', 'action_unclear', 'no_reference', 'face_missing',
                                   'multiple_faces', 'face_jump', 'flat_plane', 'shape_change', 'moire',
                                   'screen_glare', 'low_detail'))
       and private.face_timing_valid(p_details -> 'timing');
  elsif p_check = 'face_match' then
    return keys = array['calibrated', 'engine', 'lowThreshold', 'model', 'portrait', 'problems', 'reviewOnly',
                        'selfie', 'similarity', 'threshold', 'timing']
       and p_details -> 'calibrated' = 'false'::jsonb and p_details -> 'reviewOnly' = 'true'::jsonb
       and jsonb_typeof(p_details -> 'threshold') = 'number' and jsonb_typeof(p_details -> 'lowThreshold') = 'number'
       and jsonb_typeof(p_details -> 'similarity') in ('number', 'null')
       and jsonb_typeof(p_details -> 'portrait') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'portrait') k order by k collate "C") = array['box', 'captureId']
       and jsonb_typeof(p_details -> 'selfie') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'selfie') k order by k collate "C") = array['box', 'captureId']
       and jsonb_typeof(p_details -> 'problems') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'problems') p
          where jsonb_typeof(p) <> 'string'
             or p #>> '{}' not in ('portrait_not_found', 'selfie_not_found', 'portrait_small', 'detector_alignment',
                                   'selfie_not_frontal'))
       and private.face_timing_valid(p_details -> 'timing');
  end if;
  return false;
end;
$$;

-- As in M6/M7, plus the job's creation time (createdAt), for the time from the frames to the result.
create or replace function public.face_job_context(p_job uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobId', fj.id, 'kind', fj.kind, 'verificationId', fj.verification_id, 'status', fj.status,
    'attempts', fj.attempts, 'challengeId', fj.challenge_id, 'actions', to_jsonb(lc.actions),
    'inputs', coalesce(fj.inputs, '[]'::jsonb), 'createdAt', fj.created_at,
    'live', jsonb_array_length(coalesce(fj.inputs, '[]'::jsonb)) > 0 and not exists (
      select 1 from jsonb_array_elements(fj.inputs) i
      left join public.capture c on c.id::text = i ->> 'captureId'
      where c.id is null or c.deleted_at is not null))
  from public.face_job fj
  join public.liveness_challenge lc on lc.id = fj.challenge_id
  where fj.id = p_job
$$;


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function private.risk_signal_codes() from public;
revoke execute on function private.risk_optional_signal_defaults() from public;
revoke execute on function private.risk_config_errors(jsonb) from public;
revoke execute on function private.risk_normalise_config(jsonb) from public;
revoke execute on function private.risk_evaluate(jsonb, jsonb) from public;
revoke execute on function private.risk_facts(uuid) from public;
revoke execute on function private.face_timing_valid(jsonb) from public;
revoke execute on function private.liveness_metrics_valid(jsonb) from public;
revoke execute on function private.face_details_valid(text, jsonb) from public;
revoke execute on function public.face_job_context(uuid) from public, anon, authenticated;
grant execute on function public.face_job_context(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The new threshold version: the active settings with print_name_mismatch written out. Audited like an
-- admin's version (actor system, the migration named).
-- ---------------------------------------------------------------------------
do $$
declare
  cur public.threshold_config;
  config jsonb;
  next_version integer;
begin
  select * into cur from public.threshold_config tc order by tc.version desc limit 1;
  if cardinality(private.risk_config_errors(cur.config)) > 0 then
    raise exception 'real_test_fixes: the active threshold version is not valid';
  end if;
  config := private.risk_normalise_config(cur.config);
  next_version := cur.version + 1;
  insert into public.threshold_config (version, config, note, created_by_migration)
  values (next_version, config, 'Fixes after the PM''s first real test', '20261022000000_real_test_fixes');
  insert into public.audit_event (actor_type, action, target_type, target_id, details)
  values ('system', 'threshold_config.create', 'threshold_config', next_version::text,
          jsonb_build_object('version', next_version, 'baseVersion', cur.version,
                             'changes', to_jsonb(private.risk_config_changes(cur.config, config)),
                             'migration', '20261022000000_real_test_fixes'));
end $$;

-- As for any new version, every case waiting for a decision is assessed again with it (the PM's session
-- among them); a migration's re-assessment never approves a case (trigger 'migration').
do $$
declare
  case_id uuid;
begin
  for case_id in select vv.id from public.verification vv where vv.status = 'submitted' order by vv.submitted_at, vv.id loop
    perform private.risk_refresh_safe(case_id, 'migration');
  end loop;
end $$;
