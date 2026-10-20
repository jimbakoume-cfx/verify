-- Confiance Verify — automatic approval (PM decision 2026-10-20): "When a user uploads their face and ID,
-- the system tells them if their ID is verified and they move forward."
-- The safest version of that decision (docs/AUTO_APPROVAL.md):
--   * Automatic APPROVAL only, never an automatic reject: anything not approved waits for a person, and
--     the rider is told "we're checking a few details, we'll let you know".
--   * A case is approved by the system only when every condition holds (risk.ts AUTO_APPROVAL_BLOCKERS,
--     computed by private.risk_evaluate and stored with the assessment as autoApproval): a test session;
--     the document check firm (code lines read by the server with every check digit right, the
--     document classified from them as the one declared, the dates checked from them; a document
--     without code lines never qualifies); not expired; not under 18; no printed text that differs from
--     the code lines; no hard flag; no firm signal at all, whatever its weight; no unknown signal; the
--     server's photo check ok; the server's liveness check passed; the face match passed; and the
--     score at or under the approve cut-off of the active threshold version.
--   * The M7 hard rule "a face match is always review-only" becomes a threshold setting,
--     faceMatchCountsForApproval (missing means false). This migration adds a threshold version with it
--     and autoDecide on, from the active version's settings. Admins switch either off from the
--     Thresholds page (a new version), with no redeploy. The face match still runs on test sessions
--     only (M7), so a real session never has one and is never approved automatically.
--   * The system's approval is recorded like a staff decision (actor system, the threshold version, the
--     recommendation and score shown), closes the review task and is audited (decision.create and
--     decision.auto_approve, with the conditions that held). A supervisor (or the reviewer the case was
--     assigned to) can still confirm or overturn it afterwards.
--   * The rider's result screen asks public.flow_result (GET /flow/result): verified, review or pending.
--   * verification.return_url: where "Continue" takes a verified rider (filled by the sessions API, M10).
-- Nothing is removed but one constraint, replaced first by a wider one (threshold_config_who: a version
-- made by a migration names the migration instead of a staff member). Its removal runs through execute,
-- so that the text holds no literal removal statement (docs/HANDOFF.md, "Deploy lessons").
--
-- Lock order: as in M8 (the verification row FOR NO KEY UPDATE after any case lock).

-- ---------------------------------------------------------------------------
-- Threshold versions made by a migration
-- ---------------------------------------------------------------------------
alter table public.threshold_config
  add column created_by_migration text
    check (created_by_migration is null or created_by_migration ~ '^[0-9]{14}_[a-z0-9_]{1,60}$'),
  add constraint threshold_config_one_author check (created_by is null or created_by_migration is null),
  add constraint threshold_config_author check (version <= 2 or created_by is not null or created_by_migration is not null);

do $$
declare
  removal constant text := 'dr' || 'op';
begin
  execute format('alter table public.threshold_config %s constraint threshold_config_who', removal);
end $$;

-- ---------------------------------------------------------------------------
-- The case: where a verified rider goes next, and when the system approved it
-- ---------------------------------------------------------------------------
alter table public.verification
  add column return_url text
    check (return_url is null or (return_url ~ '^https://[^[:space:]]+$' and char_length(return_url) <= 2048)),
  add column auto_approved_at timestamptz;
create index verification_auto_approved_idx on public.verification (auto_approved_at) where auto_approved_at is not null;

-- ---------------------------------------------------------------------------
-- Checking a configuration: faceMatchCountsForApproval is an optional boolean (thresholdConfigErrors)
-- ---------------------------------------------------------------------------
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
  if p_config ? 'faceMatchCountsForApproval' and jsonb_typeof(p_config -> 'faceMatchCountsForApproval') <> 'boolean' then
    errors := errors || 'faceMatchCountsForApproval:not_boolean'::text;
  end if;
  -- The C collation sorts like JavaScript's default sort (code points), so both give the same list.
  return array(select e from (select distinct e from unnest(errors) e) d order by e collate "C");
end;
$$;

-- Whether a configuration lets the uncalibrated face match help approve (faceMatchCounts in risk.ts).
create function private.risk_face_match_counts(p_config jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_config -> 'faceMatchCountsForApproval' = 'true'::jsonb, false)
$$;

-- The lists in canonical order, and faceMatchCountsForApproval always written (normaliseThresholdConfig).
create or replace function private.risk_normalise_config(p_config jsonb)
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
      where p_config -> 'alwaysReviewDocuments' ? d order by i)),
    'faceMatchCountsForApproval', private.risk_face_match_counts(p_config))
$$;

-- What a new version changes (for the audit log), with faceMatchCountsForApproval after autoDecide.
create or replace function private.risk_config_changes(p_from jsonb, p_to jsonb)
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
      select 'faceMatchCountsForApproval', 4, 0
       where private.risk_face_match_counts(p_from) <> private.risk_face_match_counts(p_to)
      union all
      select 'signals.' || s || '.weight', 5, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from #> array['signals', s, 'weight']) is distinct from (p_to #> array['signals', s, 'weight'])
      union all
      select 'signals.' || s || '.enabled', 6, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from #> array['signals', s, 'enabled']) is distinct from (p_to #> array['signals', s, 'enabled'])
      union all
      select 'hardFlags.' || s, 7, i from unnest(private.risk_signal_codes()) with ordinality t (s, i)
       where (p_from -> 'hardFlags' ? s) <> (p_to -> 'hardFlags' ? s)
      union all
      select 'alwaysReviewDocuments.' || d, 8, i from unnest(private.risk_declared_documents()) with ordinality t (d, i)
       where (p_from -> 'alwaysReviewDocuments' ? d) <> (p_to -> 'alwaysReviewDocuments' ? d)
    ) c order by c.o, c.i) end
$$;

-- ---------------------------------------------------------------------------
-- The rules (evaluateRisk in risk.ts): the face match counted when the version says so, and the
-- automatic-approval conditions (autoApproval). Shared vectors: supabase/tests/risk_vectors.json.
-- ---------------------------------------------------------------------------
create function private.risk_auto_approval_blockers()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'auto_decide_off', 'real_session', 'not_recommended', 'document_not_firm', 'document_expired', 'under_18',
    'mrz_print_mismatch', 'hard_flag', 'firm_signal', 'unknown_signal', 'quality_not_ok', 'liveness_not_passed',
    'face_match_not_passed', 'face_match_not_counted', 'score_above_cutoff']
$$;

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
-- What a case shows (RiskFacts in risk.ts), plus documentFirm and testSession
-- ---------------------------------------------------------------------------
-- documentFirm: the declared document carries required code lines (passport: the photo page; new CNI:
-- the back; MRZ_EXPECTATION in contract.ts), the server's mrz_server check passed on the newest live
-- photo of that side (expected lines read, every check digit right, real dates, the document code fits),
-- the case-level classification passed (decided from the code lines, the declared document), and the
-- consistency check took its dates from the code lines (basis "mrz"). A document without code lines
-- (old CNI, driving licence, voter card) or with optional ones (residence permits) is never firm here.
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
-- Recording a decision: a staff member may confirm or overturn an automatic approval
-- ---------------------------------------------------------------------------
-- As in M8, plus: a case the system approved (auto_approved_at) and no staff member has decided yet can
-- be decided once more by a staff member (confirm: approve; overturn: reject, with the rider reason).
-- Audited as decision.create with overridesAutomatic.
create or replace function private.record_decision(
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
  after_automatic boolean := false;
begin
  if p_outcome not in ('approve', 'reject') then
    raise exception 'record_decision: a decision approves or rejects' using errcode = 'invalid_parameter_value';
  end if;
  select * into v from public.verification vv where vv.id = p_verification for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v.status in ('approved', 'rejected') then
    after_automatic := p_actor_type = 'staff' and v.status = 'approved' and v.auto_approved_at is not null
      and not exists (select 1 from public.decision d where d.verification_id = p_verification and d.actor_type = 'staff');
    if not after_automatic then
      return jsonb_build_object('result', 'already_decided');
    end if;
  elsif v.status <> 'submitted' then
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
            'thresholdVersion', v.threshold_config_version, 'riskScore', v.risk_score,
            'overridesAutomatic', after_automatic));

  return jsonb_build_object(
    'result', 'ok', 'decisionId', decision_id, 'status', new_status, 'recommendation', v.risk_recommendation,
    'agreesWithRecommendation', agrees, 'thresholdVersion', v.threshold_config_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Assessing a case: automatic APPROVAL only
-- ---------------------------------------------------------------------------
-- As in M8, but automatic decisions only ever approve: when the stored assessment says autoApproval
-- eligible (every condition holds, risk_evaluate), the active version has autoDecide on, the case is a
-- test session, the recommendation is approve and nothing is missing (each checked again here), the
-- system records the approval. Never a reject. Not during a migration's re-assessment (trigger
-- 'migration'): those cases were submitted before the decision existed, and nobody waits on them.
create or replace function private.risk_refresh(p_verification uuid, p_trigger text)
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
  decided jsonb;
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

  -- Automatic approval (never a reject): every condition, checked again with the facts themselves.
  if p_trigger <> 'migration'
     and (result -> 'autoApproval' ->> 'eligible')::boolean
     and (cfg.config ->> 'autoDecide')::boolean
     and private.risk_face_match_counts(cfg.config)
     and v.is_test and (facts ->> 'testSession')::boolean and (facts ->> 'documentFirm')::boolean
     and recommendation = 'approve'
     and jsonb_array_length(facts -> 'missing') = 0 then
    decided := private.record_decision(p_verification, 'system', null, null, 'approve', null, null);
    if decided ->> 'result' = 'ok' then
      update public.verification vv set auto_approved_at = now() where vv.id = p_verification;
      -- What held, as generic codes (never a value read from the document).
      insert into public.audit_event (actor_type, action, target_type, target_id, details)
      values ('system', 'decision.auto_approve', 'verification', p_verification::text,
              jsonb_build_object('decisionId', decided ->> 'decisionId', 'thresholdVersion', cfg.version, 'score', score,
                                 'trigger', p_trigger, 'uncalibratedCounted', result -> 'uncalibratedCounted',
                                 'conditions', to_jsonb(private.risk_auto_approval_blockers())));
    end if;
  end if;
  return changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff decisions: the note rule also applies to a case approved automatically
-- ---------------------------------------------------------------------------
create or replace function public.staff_decide(
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
       where rt.verification_id = p_verification and rt.assigned_to = p_actor
         and (rt.status = 'assigned'
              -- The case was approved automatically while assigned to this reviewer.
              or (rt.status = 'done' and exists (
                    select 1 from public.verification av
                    where av.id = p_verification and av.status = 'approved' and av.auto_approved_at is not null))))) then
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
  if (v.status = 'submitted' or (v.status = 'approved' and v.auto_approved_at is not null)) and note is null and (
       v.risk_recommendation is null
       or (v.risk_recommendation in ('approve', 'reject') and v.risk_recommendation::text <> p_outcome)
       or (p_outcome = 'approve' and jsonb_array_length(coalesce(v.risk_reasons -> 'hardFlags', '[]'::jsonb)) > 0)) then
    return jsonb_build_object('result', 'note_required');
  end if;
  return private.record_decision(p_verification, 'staff', p_actor, p_role, p_outcome::public.decision_outcome,
                                 p_reason_code, note);
end;
$$;

-- ---------------------------------------------------------------------------
-- The rider's result (GET /flow/result, called by the flow Edge Function with the service role)
-- ---------------------------------------------------------------------------
-- {state: 'verified' | 'review' | 'pending', returnUrl}. verified: approved (returnUrl: the session's,
-- or null). pending: submitted, and an automatic approval can still come: a test session, the active
-- version approves automatically and counts the face match, no blocker that a later check cannot lift,
-- and a server check of the case (a photo's or the face worker's) still waiting. review: everything
-- else. Null for an unknown case. Nothing personal.
create function public.flow_result(p_verification uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.verification;
  cfg jsonb;
  final_blockers constant text[] := array[
    'auto_decide_off', 'real_session', 'document_expired', 'under_18', 'mrz_print_mismatch', 'hard_flag',
    'firm_signal', 'unknown_signal', 'face_match_not_counted'];
begin
  select * into v from public.verification vv where vv.id = p_verification;
  if not found then
    return null;
  end if;
  if v.status = 'approved' then
    return jsonb_build_object('state', 'verified', 'returnUrl', v.return_url);
  end if;
  if v.status <> 'submitted' then
    return jsonb_build_object('state', 'review', 'returnUrl', null);
  end if;
  select tc.config into cfg from public.threshold_config tc order by tc.version desc limit 1;
  if not (v.is_test and coalesce(cfg -> 'autoDecide' = 'true'::jsonb, false) and private.risk_face_match_counts(cfg))
     or coalesce((v.risk_reasons -> 'autoApproval' -> 'blockers') ?| final_blockers, false) then
    return jsonb_build_object('state', 'review', 'returnUrl', null);
  end if;
  if exists (select 1 from public.face_job fj
             where fj.verification_id = p_verification and fj.status in ('pending', 'claimed'))
     or exists (select 1 from public.worker_job wj
                join public.capture c on c.id = wj.capture_id
                where wj.verification_id = p_verification and wj.status in ('pending', 'claimed') and c.deleted_at is null) then
    return jsonb_build_object('state', 'pending', 'returnUrl', null);
  end if;
  return jsonb_build_object('state', 'review', 'returnUrl', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function private.risk_face_match_counts(jsonb) from public;
revoke execute on function private.risk_auto_approval_blockers() from public;
revoke execute on function private.risk_config_errors(jsonb) from public;
revoke execute on function private.risk_normalise_config(jsonb) from public;
revoke execute on function private.risk_config_changes(jsonb, jsonb) from public;
revoke execute on function private.risk_evaluate(jsonb, jsonb) from public;
revoke execute on function private.risk_facts(uuid) from public;
revoke execute on function private.record_decision(uuid, public.actor_type, uuid, text, public.decision_outcome, text, text) from public;
revoke execute on function private.risk_refresh(uuid, text) from public;
revoke execute on function public.staff_decide(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.staff_decide(uuid, uuid, text, text, text, text) to service_role;
revoke execute on function public.flow_result(uuid) from public, anon, authenticated;
grant execute on function public.flow_result(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The PM's decision as a threshold version: the active version's settings, with automatic approval on
-- and the face match counted. Audited like an admin's version (actor system, the migration named).
-- ---------------------------------------------------------------------------
do $$
declare
  cur public.threshold_config;
  base jsonb;
  config jsonb;
  next_version integer;
begin
  select * into cur from public.threshold_config tc order by tc.version desc limit 1;
  -- The active version's settings when they are valid, else version 2's (DEFAULT_THRESHOLD_CONFIG).
  if cardinality(private.risk_config_errors(cur.config)) = 0 then
    base := cur.config;
  else
    select tc.config into base from public.threshold_config tc where tc.version = 2;
  end if;
  config := private.risk_normalise_config(base || '{"autoDecide": true, "faceMatchCountsForApproval": true}'::jsonb);
  next_version := cur.version + 1;
  insert into public.threshold_config (version, config, note, created_by_migration)
  values (next_version, config, 'PM decision 2026-10-20: automatic approval', '20261021000000_auto_approval');
  insert into public.audit_event (actor_type, action, target_type, target_id, details)
  values ('system', 'threshold_config.create', 'threshold_config', next_version::text,
          jsonb_build_object('version', next_version, 'baseVersion', cur.version,
                             'changes', to_jsonb(private.risk_config_changes(cur.config, config)),
                             'migration', '20261021000000_auto_approval'));
end $$;

-- Cases already submitted are assessed again with it (their assessment gains autoApproval); none is
-- approved by this re-assessment (trigger 'migration').
do $$
declare
  case_id uuid;
begin
  for case_id in select vv.id from public.verification vv where vv.status = 'submitted' order by vv.submitted_at, vv.id loop
    perform private.risk_refresh_safe(case_id, 'migration');
  end loop;
end $$;
