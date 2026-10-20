-- Confiance Verify — M6 (server-side liveness evaluation) and M7 (face match), run by a second worker.
--   * The face worker is a second Vercel Python function (worker-face/, project confiance-verify-face):
--     the face models do not fit beside the OCR models in one 500 MB function. It uses the AI worker's
--     protocol unchanged (M3): Ed25519-signed claims through its own Edge Function ("face"), photos
--     relayed (never a URL), the results decided and recorded by the Edge Function, a ring that carries
--     no authority, a test-only switch and a daily cap.
--   * worker_key.scope: a key signs for one function only. The AI worker's keys are "documents" (every
--     key so far), the face worker's "face" (key id f1). Both functions look keys up by scope, and each
--     nonce function refuses a key of the other scope.
--   * worker_settings: face_enabled_for_real_sessions (default false) and face_daily_job_cap (100).
--     The face match never runs on a real session, whatever the switch: AuraFace is for test sessions
--     only (PM, 2026-10-19), changed by a migration once the licence question is settled.
--   * face_job: one "liveness" job per recorded face check, and one "face_match" job per (face check,
--     document front) pair. Created by triggers when the frames are recorded and when a new front photo
--     arrives; a newer face check or front supersedes the older jobs and removes their results.
--   * check_result "liveness" and "face_match" (one per case each, capture_id null): the names M8 counts.
--     Their details are refused unless they have exactly the contract's keys (generic codes and scores;
--     for face_match calibrated = false and reviewOnly = true, always).
--   * M8: a face_match result is REVIEW-ONLY (hard rule, private.face_match_review_only()): a case that
--     has one is never recommended for approval, hence never approved automatically, until the threshold
--     is calibrated on Cameroonian impostor pairs and a migration changes the rule. The assessment lists
--     it (reviewOnly, reason review_only_check). Placed in the rules rather than in threshold_config so
--     that no admin can switch it off from the dashboard.
--   * private.face_sweep() every minute (pg_cron): requeues, gives up, rings the face worker.
--   * private.face_training_cases(): the cases whose rider ticked "keep my face images" (M5), the only
--     ones whose face images may be kept beyond normal retention for training.
-- Nothing is removed, and the text holds no removal statement (docs/HANDOFF.md).

-- ---------------------------------------------------------------------------
-- Keys are scoped to one function
-- ---------------------------------------------------------------------------
alter table public.worker_key
  add column scope text not null default 'documents' check (scope in ('documents', 'face'));

-- The AI worker's nonce function (M3), now for "documents" keys only.
create or replace function public.worker_use_nonce(p_kid text, p_nonce text, p_expires_at timestamptz)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.worker_key k where k.kid = p_kid and k.revoked_at is null and k.scope = 'documents') then
    return 'revoked';
  end if;
  insert into public.worker_nonce (nonce, expires_at) values (p_nonce, p_expires_at)
  on conflict (nonce) do nothing;
  if not found then
    return 'replayed';
  end if;
  return 'ok';
end;
$$;

-- The face worker's: "face" keys only. The nonce table is shared (nonces are random, 128 bits).
create function public.face_use_nonce(p_kid text, p_nonce text, p_expires_at timestamptz)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.worker_key k where k.kid = p_kid and k.revoked_at is null and k.scope = 'face') then
    return 'revoked';
  end if;
  insert into public.worker_nonce (nonce, expires_at) values (p_nonce, p_expires_at)
  on conflict (nonce) do nothing;
  if not found then
    return 'replayed';
  end if;
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings: the face worker's own switch and cap
-- ---------------------------------------------------------------------------
alter table public.worker_settings
  -- Off until Vercel Pro and its DPA are in place, as the AI worker's switch. Liveness only: the face
  -- match stays on test sessions whatever this says.
  add column face_enabled_for_real_sessions boolean not null default false,
  -- Face jobs started per day (Douala time); beyond it they end 'failed' with code 'budget'.
  add column face_daily_job_cap integer not null default 100 check (face_daily_job_cap >= 0);

-- Where the face sweep rings the face worker (public; a ring carries no authority). Created only once.
do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'face_ring_url') then
    perform vault.create_secret(
      'https://confiance-verify-face.vercel.app/api/process',
      'face_ring_url',
      'Doorbell of the face worker (M6/M7), rung by private.face_sweep() through pg_net. Public URL; a ring carries no authority.'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create table public.face_job (
  id                   uuid primary key default gen_random_uuid(),
  verification_id      uuid not null references public.verification (id) on delete cascade,
  kind                 text not null check (kind in ('liveness', 'face_match')),
  -- The face check whose frames the job reads.
  challenge_id         uuid not null references public.liveness_challenge (id) on delete cascade,
  -- face_match: the document front whose portrait it compares.
  document_capture_id  uuid references public.capture (id) on delete cascade,
  -- pending, claimed, done, failed (error_code says why), superseded (a newer face check or front).
  status               text not null default 'pending'
                         check (status in ('pending', 'claimed', 'done', 'failed', 'superseded')),
  attempts             integer not null default 0 check (attempts between 0 and 3),
  lease_until          timestamptz,
  first_claimed_at     timestamptz,
  error_code           text check (error_code in ('budget', 'ineligible', 'attempts', 'expired')),
  -- What the last claim handed out ([{captureId, role, index, step}]): /image relays nothing else.
  inputs               jsonb check (inputs is null or jsonb_typeof(inputs) = 'array'),
  -- The worker's measures (numbers only, never a landmark or an embedding). Not readable by staff.
  evidence             jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((kind = 'face_match') = (document_capture_id is not null)),
  check ((status = 'failed') = (error_code is not null)),
  check ((status = 'claimed') = (lease_until is not null)),
  check ((status = 'done') = (evidence is not null))
);
create index face_job_queue_idx on public.face_job (created_at) where status in ('pending', 'claimed');
create index face_job_verification_idx on public.face_job (verification_id, kind);
create index face_job_challenge_idx on public.face_job (challenge_id);
create index face_job_document_idx on public.face_job (document_capture_id) where document_capture_id is not null;
create index face_job_first_claimed_idx on public.face_job (first_claimed_at) where first_claimed_at is not null;

alter table public.face_job enable row level security;
revoke all on public.face_job from anon, authenticated;
-- As worker_job (M3): staff read whether each face job waits, is done or failed, nothing else of it,
-- under the same rule as the photos.
grant select (verification_id, kind, status) on public.face_job to authenticated;
create policy "supervisors see all, reviewers see assigned" on public.face_job
  for select to authenticated
  using ((select private.is_staff_at_least('supervisor')) or private.is_assigned_reviewer(verification_id));

-- ---------------------------------------------------------------------------
-- Creating the jobs
-- ---------------------------------------------------------------------------
-- The face check whose frames are live (one at a time: a newer one erases the older frames, M5).
create function private.face_current_challenge(p_verification uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select c.liveness_challenge_id
    from public.capture c
   where c.verification_id = p_verification and c.kind = 'liveness_frame' and c.deleted_at is null
   order by c.created_at desc, c.id
   limit 1
$$;

-- Supersedes the jobs whose inputs are no longer the case's (and removes their results), then creates
-- the jobs the case's current face check and front need. A real session gets them already failed
-- ('ineligible') when it may not run them: liveness while the face switch is off, face_match always.
-- The caller holds the case lock (private.worker_lock_case, the one lock order of every case writer).
create function private.face_refresh_jobs(p_verification uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  challenge uuid := private.face_current_challenge(p_verification);
  front uuid;
  v public.verification;
  settings public.worker_settings;
  superseded_liveness integer;
  superseded_match integer;
  liveness_ok boolean;
  match_ok boolean;
begin
  select n.capture_id into front from private.worker_newest_captures(p_verification) n where n.kind = 'document_front';

  update public.face_job fj set status = 'superseded', lease_until = null, updated_at = now()
   where fj.verification_id = p_verification and fj.kind = 'liveness' and fj.status in ('pending', 'claimed')
     and fj.challenge_id is distinct from challenge;
  get diagnostics superseded_liveness = row_count;
  update public.face_job fj set status = 'superseded', lease_until = null, updated_at = now()
   where fj.verification_id = p_verification and fj.kind = 'face_match' and fj.status in ('pending', 'claimed')
     and (fj.challenge_id is distinct from challenge or fj.document_capture_id is distinct from front);
  get diagnostics superseded_match = row_count;

  -- A result is about its inputs: when they change, it goes (the case misses it until the new job ends).
  delete from public.check_result cr
   where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'liveness'
     and (challenge is null or cr.details ->> 'challengeId' is distinct from challenge::text);
  delete from public.check_result cr
   where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'face_match'
     and (challenge is null or front is null
          or cr.details #>> '{portrait,captureId}' is distinct from front::text
          or not exists (select 1 from public.capture c
                          where c.liveness_challenge_id = challenge and c.deleted_at is null
                            and c.id::text = cr.details #>> '{selfie,captureId}')
             and cr.details #>> '{selfie,captureId}' is not null);

  if challenge is null then
    return;
  end if;
  select * into v from public.verification vv where vv.id = p_verification;
  select * into settings from public.worker_settings ws where ws.id;
  liveness_ok := v.is_test or coalesce(settings.face_enabled_for_real_sessions, false);
  -- AuraFace: test sessions only, whatever the switch (PM, 2026-10-19).
  match_ok := v.is_test;

  if not exists (select 1 from public.face_job fj
                  where fj.verification_id = p_verification and fj.kind = 'liveness' and fj.challenge_id = challenge
                    and fj.status <> 'superseded') then
    insert into public.face_job (verification_id, kind, challenge_id, status, error_code)
    values (p_verification, 'liveness', challenge,
            case when liveness_ok then 'pending' else 'failed' end,
            case when liveness_ok then null else 'ineligible' end);
  end if;
  if front is not null and not exists (
       select 1 from public.face_job fj
        where fj.verification_id = p_verification and fj.kind = 'face_match' and fj.challenge_id = challenge
          and fj.document_capture_id = front and fj.status <> 'superseded') then
    insert into public.face_job (verification_id, kind, challenge_id, document_capture_id, status, error_code)
    values (p_verification, 'face_match', challenge, front,
            case when match_ok then 'pending' else 'failed' end,
            case when match_ok then null else 'ineligible' end);
  end if;
end;
$$;

-- When a face check's frames are recorded (flow_record_liveness marks its challenge used).
create function private.liveness_challenge_face_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.worker_lock_case(new.verification_id);
  perform private.face_refresh_jobs(new.verification_id);
  return null;
end;
$$;

create trigger liveness_challenge_face_jobs
  after update of used_at on public.liveness_challenge
  for each row
  when (old.used_at is null and new.used_at is not null)
  execute function private.liveness_challenge_face_jobs();

-- When a new document front arrives (a retake, or another document): the face match is redone.
create function private.capture_face_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.worker_lock_case(new.verification_id);
  perform private.face_refresh_jobs(new.verification_id);
  return null;
end;
$$;

create trigger capture_face_jobs
  after insert on public.capture
  for each row
  when (new.kind = 'document_front' and new.deleted_at is null)
  execute function private.capture_face_jobs();

-- Gives up on a face job: audited (codes only).
create function private.face_fail_job(p_job uuid, p_code text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  j public.face_job;
begin
  update public.face_job fj
     set status = 'failed', error_code = p_code, lease_until = null, updated_at = now()
   where fj.id = p_job
  returning * into j;
  insert into public.audit_event (actor_type, action, target_type, target_id, details)
  values ('system', 'face.job_failed', 'verification', j.verification_id::text,
          jsonb_build_object('jobId', j.id, 'kind', j.kind, 'code', p_code, 'attempts', j.attempts));
end;
$$;

-- The inputs of a job as the worker sees them: the live frames of its face check in index order, then
-- (face_match) the document front. Empty when an input is gone.
create function private.face_job_inputs(p_job uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with j as (select * from public.face_job fj where fj.id = p_job),
  frames as (
    select jsonb_build_object(
             'captureId', c.id, 'role', 'frame',
             'index', (c.quality #>> '{liveness,index}')::integer,
             'step', (c.quality #>> '{liveness,step}')::integer,
             'atMs', (c.quality #>> '{liveness,atMs}')::integer,
             'sha256', c.sha256, 'byteSize', c.byte_size, 'width', c.width, 'height', c.height) as input,
           (c.quality #>> '{liveness,index}')::integer as position
      from public.capture c, j
     where c.liveness_challenge_id = j.challenge_id and c.kind = 'liveness_frame' and c.deleted_at is null
  ),
  document as (
    select jsonb_build_object(
             'captureId', c.id, 'role', 'document', 'index', null, 'step', null, 'atMs', null,
             'sha256', c.sha256, 'byteSize', c.byte_size, 'width', c.width, 'height', c.height) as input
      from public.capture c, j
     where c.id = j.document_capture_id and c.deleted_at is null
  )
  select case
    when not exists (select 1 from frames) then '[]'::jsonb
    when (select kind from j) = 'face_match' and not exists (select 1 from document) then '[]'::jsonb
    else coalesce((select jsonb_agg(f.input order by f.position) from frames f), '[]'::jsonb)
         || coalesce((select jsonb_agg(d.input) from document d), '[]'::jsonb)
  end
$$;

-- ---------------------------------------------------------------------------
-- Face worker RPCs (called by the `face` Edge Function, service role)
-- ---------------------------------------------------------------------------
-- Hands out the oldest claimable face job as FaceClaimResponse (jsonb), or null. As worker_claim (M3):
-- one claim at a time (so the daily cap is exact), a case another writer holds is skipped, jobs that may
-- not run are given up on the way (attempts, ineligible, budget), and a job whose inputs are gone is
-- superseded. Lease 120 s.
create function public.face_claim()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.worker_settings;
  day_start constant timestamptz :=
    date_trunc('day', now() at time zone 'Africa/Douala') at time zone 'Africa/Douala';
  started integer;
  cand record;
  r record;
  claim_inputs jsonb;
  code text;
begin
  perform pg_advisory_xact_lock(hashtextextended('face_claim', 0));
  select * into settings from public.worker_settings ws where ws.id;
  if not found then
    return null; -- No settings row: fail closed.
  end if;
  select count(*) into started from public.face_job fj where fj.first_claimed_at >= day_start;

  for cand in
    select fj.id, fj.verification_id
      from public.face_job fj
     where fj.status = 'pending' or (fj.status = 'claimed' and fj.lease_until < now())
     order by fj.created_at, fj.id
     limit 100
  loop
    continue when not pg_try_advisory_xact_lock(private.worker_case_key(cand.verification_id));
    select fj.status, fj.kind, fj.attempts, fj.lease_until, fj.first_claimed_at, fj.challenge_id,
           v.status as session_status, v.is_test, v.session_expires_at, v.declared_document, lc.actions
      into r
      from public.face_job fj
      join public.verification v on v.id = fj.verification_id
      join public.liveness_challenge lc on lc.id = fj.challenge_id
     where fj.id = cand.id
       for update of fj;
    continue when not (r.status = 'pending' or (r.status = 'claimed' and r.lease_until < now()));
    claim_inputs := private.face_job_inputs(cand.id);
    if jsonb_array_length(claim_inputs) = 0 then
      update public.face_job fj set status = 'superseded', lease_until = null, updated_at = now() where fj.id = cand.id;
      continue;
    end if;

    code := case
      when r.attempts >= 3 then 'attempts'
      when not (r.session_status = 'submitted'
                or (r.session_status = 'in_progress' and r.session_expires_at > now()))
        or not (r.is_test or (r.kind = 'liveness' and settings.face_enabled_for_real_sessions)) then 'ineligible'
      when r.first_claimed_at is null and started >= settings.face_daily_job_cap then 'budget'
    end;
    if code is not null then
      perform private.face_fail_job(cand.id, code);
      continue;
    end if;

    update public.face_job fj
       set status = 'claimed', attempts = fj.attempts + 1, lease_until = now() + interval '120 seconds',
           first_claimed_at = coalesce(fj.first_claimed_at, now()), updated_at = now(),
           inputs = (select coalesce(jsonb_agg(jsonb_build_object('captureId', i -> 'captureId', 'role', i -> 'role',
                                                                  'index', i -> 'index', 'step', i -> 'step')), '[]'::jsonb)
                       from jsonb_array_elements(claim_inputs) i)
     where fj.id = cand.id;
    return jsonb_build_object(
      'jobId', cand.id, 'attempt', r.attempts + 1, 'kind', r.kind, 'testSession', r.is_test,
      'declaredDocument', r.declared_document, 'actions', to_jsonb(r.actions), 'inputs', claim_inputs);
  end loop;
  return null;
end;
$$;

-- Where to read one input of a claimed job: 'ok' for an input the current attempt was handed; 'gone'
-- when the job was superseded or the photo erased; 'not_found' otherwise.
create function public.face_image_lookup(p_job uuid, p_attempt integer, p_capture uuid)
returns table (result text, verification_id uuid, storage_path text, byte_size integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  j public.face_job;
  c public.capture;
begin
  select * into j from public.face_job fj where fj.id = p_job;
  if not found or not exists (select 1 from jsonb_array_elements(coalesce(j.inputs, '[]'::jsonb)) i
                               where i ->> 'captureId' = p_capture::text) then
    return query select 'not_found'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  select * into c from public.capture cc where cc.id = p_capture;
  if j.status = 'superseded' or c.deleted_at is not null then
    return query select 'gone'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  if j.status <> 'claimed' or j.attempts is distinct from p_attempt then
    return query select 'not_found'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  return query select 'ok'::text, c.verification_id, c.storage_path, c.byte_size;
end;
$$;

-- What a result is decided against (FaceJobContext): the job, its face check's actions and the inputs
-- its last claim handed out, and whether they are all still live. Null for an unknown job.
create function public.face_job_context(p_job uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobId', fj.id, 'kind', fj.kind, 'verificationId', fj.verification_id, 'status', fj.status,
    'attempts', fj.attempts, 'challengeId', fj.challenge_id, 'actions', to_jsonb(lc.actions),
    'inputs', coalesce(fj.inputs, '[]'::jsonb),
    'live', jsonb_array_length(coalesce(fj.inputs, '[]'::jsonb)) > 0 and not exists (
      select 1 from jsonb_array_elements(fj.inputs) i
      left join public.capture c on c.id::text = i ->> 'captureId'
      where c.id is null or c.deleted_at is not null))
  from public.face_job fj
  join public.liveness_challenge lc on lc.id = fj.challenge_id
  where fj.id = p_job
$$;

-- The exact keys of the details (contract.ts LIVENESS_EVAL_DETAIL_KEYS, FACE_MATCH_DETAIL_KEYS), with
-- their codes and fixed values: anything else is refused, so nothing but codes and scores reaches
-- check_result, which supervisors and admins read.
create function private.face_details_valid(p_check text, p_details jsonb)
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
  keys := array(select k from jsonb_object_keys(p_details) k order by k);
  if p_check = 'liveness' then
    return keys = array['actions', 'challengeId', 'engine', 'evaluated', 'flatPlane', 'flatPlaneScore', 'frames',
                        'framesWithFace', 'problems', 'provisional', 'timing']
       and p_details -> 'evaluated' = 'true'::jsonb and p_details -> 'provisional' = 'true'::jsonb
       and p_details ->> 'flatPlane' in ('depth', 'flat', 'not_measured')
       and jsonb_typeof(p_details -> 'actions') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'actions') a
          where jsonb_typeof(a) <> 'object'
             or array(select k from jsonb_object_keys(a) k order by k) <> array['action', 'framesWithFace', 'peak', 'result']
             or a ->> 'action' not in ('turn_left', 'turn_right', 'look_up', 'blink', 'smile')
             or a ->> 'result' not in ('pass', 'fail', 'unclear'))
       and jsonb_typeof(p_details -> 'problems') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'problems') p
          where jsonb_typeof(p) <> 'string'
             or p #>> '{}' not in ('action_not_done', 'wrong_direction', 'action_unclear', 'no_reference', 'face_missing',
                                   'multiple_faces', 'face_jump', 'flat_plane', 'shape_change', 'moire',
                                   'screen_glare', 'low_detail'))
       and jsonb_typeof(p_details -> 'timing') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'timing') k order by k) = array['cold', 'ms'];
  elsif p_check = 'face_match' then
    return keys = array['calibrated', 'engine', 'lowThreshold', 'model', 'portrait', 'problems', 'reviewOnly',
                        'selfie', 'similarity', 'threshold', 'timing']
       and p_details -> 'calibrated' = 'false'::jsonb and p_details -> 'reviewOnly' = 'true'::jsonb
       and jsonb_typeof(p_details -> 'threshold') = 'number' and jsonb_typeof(p_details -> 'lowThreshold') = 'number'
       and jsonb_typeof(p_details -> 'similarity') in ('number', 'null')
       and jsonb_typeof(p_details -> 'portrait') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'portrait') k order by k) = array['box', 'captureId']
       and jsonb_typeof(p_details -> 'selfie') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'selfie') k order by k) = array['box', 'captureId']
       and jsonb_typeof(p_details -> 'problems') = 'array'
       and not exists (
         select 1 from jsonb_array_elements(p_details -> 'problems') p
          where jsonb_typeof(p) <> 'string'
             or p #>> '{}' not in ('portrait_not_found', 'selfie_not_found', 'portrait_small', 'detector_alignment',
                                   'selfie_not_frontal'))
       and jsonb_typeof(p_details -> 'timing') = 'object'
       and array(select k from jsonb_object_keys(p_details -> 'timing') k order by k) = array['cold', 'ms'];
  end if;
  return false;
end;
$$;

-- Records a face job's result: the case-level check ("liveness" or "face_match"), the job's evidence and
-- one audit entry, all together or not at all. 'recorded'; 'already_done' (the first result wins);
-- 'gone' (superseded, or an input erased); 'not_found' (unknown job or attempt).
create function public.face_record_result(
  p_kid text,
  p_job uuid,
  p_attempt integer,
  p_check text,
  p_version text,
  p_outcome public.check_outcome,
  p_score numeric,
  p_details jsonb,
  p_evidence jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.face_job;
  live boolean;
begin
  if p_outcome is null or p_outcome not in ('pass', 'flag', 'fail') or p_version is null
     or p_version !~ '^[a-z0-9.-]{1,40}$' or jsonb_typeof(p_evidence) is distinct from 'object'
     or (p_score is not null and (p_score < -1 or p_score > 1)) or not private.face_details_valid(p_check, p_details) then
    raise exception 'face_record_result: unexpected result' using errcode = 'invalid_parameter_value';
  end if;

  select * into j from public.face_job fj where fj.id = p_job;
  if not found then
    return 'not_found';
  end if;
  perform private.worker_lock_case(j.verification_id);
  select * into j from public.face_job fj where fj.id = p_job for update;
  if p_attempt is null or p_attempt < 1 or p_attempt > j.attempts then
    return 'not_found';
  end if;
  if (j.kind = 'liveness') <> (p_check = 'liveness') then
    raise exception 'face_record_result: the check is not the job''s' using errcode = 'invalid_parameter_value';
  end if;
  if j.status = 'done' then
    return 'already_done';
  end if;
  select jsonb_array_length(coalesce(j.inputs, '[]'::jsonb)) > 0 and not exists (
           select 1 from jsonb_array_elements(j.inputs) i
           left join public.capture c on c.id::text = i ->> 'captureId'
           where c.id is null or c.deleted_at is not null)
    into live;
  if j.status = 'superseded' or not live then
    return 'gone';
  end if;
  -- The details describe this job's own inputs.
  if (p_check = 'liveness' and p_details ->> 'challengeId' is distinct from j.challenge_id::text)
     or (p_check = 'face_match' and (
           p_details #>> '{portrait,captureId}' is distinct from j.document_capture_id::text
           or (p_details #>> '{selfie,captureId}' is not null and not exists (
                 select 1 from jsonb_array_elements(j.inputs) i
                  where i ->> 'role' = 'frame' and i ->> 'captureId' = p_details #>> '{selfie,captureId}')))) then
    raise exception 'face_record_result: details do not match the job' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.check_result (verification_id, check_name, check_version, outcome, score, details)
  values (j.verification_id, p_check, p_version, p_outcome, p_score, p_details)
  on conflict (verification_id, check_name) where capture_id is null
  do update set check_version = excluded.check_version, outcome = excluded.outcome, score = excluded.score,
                details = excluded.details, created_at = now();
  update public.face_job fj
     set status = 'done', error_code = null, lease_until = null, evidence = p_evidence, updated_at = now()
   where fj.id = j.id;
  -- Outcomes only.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('system', p_kid, 'face.result', 'verification', j.verification_id::text,
          jsonb_build_object('jobId', j.id, 'kind', j.kind, 'attempt', p_attempt, 'outcome', p_outcome));
  return 'recorded';
end;
$$;

-- ---------------------------------------------------------------------------
-- The face sweep (pg_cron, every minute)
-- ---------------------------------------------------------------------------
-- As private.worker_sweep (M3) for the face jobs: requeue an expired lease, give up after 3 attempts or
-- an hour, ring the face worker while a job waits. (The shared nonces are purged by worker_sweep.)
create function private.face_sweep()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
  requeued integer := 0;
  failed integer := 0;
  rung boolean := false;
  ring_url text;
begin
  for j in
    select fj.id, fj.verification_id
      from public.face_job fj
     where (fj.status = 'claimed' and fj.lease_until < now())
        or (fj.status in ('pending', 'claimed') and fj.created_at < now() - interval '1 hour')
     order by fj.created_at
     limit 500
  loop
    continue when not pg_try_advisory_xact_lock(private.worker_case_key(j.verification_id));
    if exists (select 1 from public.face_job fj
               where fj.id = j.id and fj.status in ('pending', 'claimed') and fj.created_at < now() - interval '1 hour'
                 and (fj.status = 'pending' or fj.lease_until < now())) then
      perform private.face_fail_job(j.id, 'expired');
      failed := failed + 1;
    elsif exists (select 1 from public.face_job fj
                  where fj.id = j.id and fj.status = 'claimed' and fj.lease_until < now() and fj.attempts >= 3) then
      perform private.face_fail_job(j.id, 'attempts');
      failed := failed + 1;
    else
      update public.face_job fj
         set status = 'pending', lease_until = null, updated_at = now()
       where fj.id = j.id and fj.status = 'claimed' and fj.lease_until < now();
      if found then
        requeued := requeued + 1;
      end if;
    end if;
  end loop;

  if exists (select 1 from public.face_job fj where fj.status = 'pending') then
    select ds.decrypted_secret into ring_url from vault.decrypted_secrets ds where ds.name = 'face_ring_url';
    if ring_url is not null and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null then
      perform net.http_post(
        url := ring_url,
        body := '{}'::jsonb,
        headers := '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds := 60000);
      rung := true;
    end if;
  end if;
  return jsonb_build_object('requeued', requeued, 'failed', failed, 'rung', rung);
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('face-sweep', '* * * * *', 'select private.face_sweep()');
  end if;
end $$;

-- What the flow function needs to decide whether to ring the face worker after a face check.
create function public.flow_face_jobs_pending(p_verification uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.face_job fj where fj.verification_id = p_verification and fj.status = 'pending')
$$;

-- ---------------------------------------------------------------------------
-- M8: liveness and face match counted; the face match is review-only
-- ---------------------------------------------------------------------------
-- Hard rule: until the face match threshold is calibrated on Cameroonian impostor pairs (NIST shows a
-- ~14x higher false-match rate for West Africans at a fixed threshold), a face_match result never helps
-- approve a case. Changing it takes a migration, with the calibration report.
create function private.face_match_review_only()
returns boolean
language sql
immutable
set search_path = ''
as $$
  select true
$$;

-- As in M8, plus: the checks counted are the case-level "liveness" and "face_match" rows; a face_match
-- result is listed under reviewOnly while private.face_match_review_only() says so.
create or replace function private.risk_facts(p_verification uuid)
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
  review_only text[] := '{}';
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
      if placeholder_name = 'face_match' and private.face_match_review_only() then
        review_only := review_only || 'face_match'::text;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'declaredDocument', declared,
    'signals', to_jsonb(array(select d.s from (select distinct s from unnest(signals) s) d order by d.s collate "C")),
    'missing', to_jsonb(array(select d.m from (select distinct m from unnest(missing) m) d order by d.m collate "C")),
    'reviewOnly', to_jsonb(review_only));
end;
$$;

-- As in M8 (evaluateRisk in risk.ts), plus the review-only checks: a case with one is never
-- recommended for approval (reason review_only_check), whatever its score. The output gains reviewOnly.
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
  approve_units numeric := (p_config ->> 'approveMax')::numeric * 10000;
  reject_units numeric := (p_config ->> 'rejectMin')::numeric * 10000;
  contributions jsonb := '[]'::jsonb;
  hard text[] := '{}';
  unknown text[];
  missing text[];
  review_only text[];
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
  review_only := array(select r from unnest(required) with ordinality t (r, i) where r = any (review_only_in) order by i)
              || array(select m from unnest(review_only_in) m where m <> all (required) order by m collate "C");
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
    'unknownSignals', to_jsonb(unknown),
    'rejectReasonCode', case when recommendation = 'reject' then private.risk_reject_code(first_firm) end,
    'approveMax', p_config -> 'approveMax',
    'rejectMin', p_config -> 'rejectMin');
end;
$$;

-- ---------------------------------------------------------------------------
-- Consent: the cases whose face images may be kept for training (M5's optional box)
-- ---------------------------------------------------------------------------
-- Administrators only, in the SQL editor: the training export (training/antispoof/README.md) takes
-- these cases and no other. A rider who did not tick the box (or whose latest answer is no) is never
-- listed; their images follow the normal retention (M13) and nothing more is kept.
create function private.face_training_cases()
returns table (verification_id uuid, consent_version text, keep_face_images_version text, accepted_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select latest.verification_id, latest.consent_version, latest.keep_face_images_version, latest.accepted_at
    from (select distinct on (cr.verification_id) cr.*
            from public.consent_record cr
           order by cr.verification_id, cr.accepted_at desc, cr.id) latest
   where latest.keep_face_images
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function private.face_current_challenge(uuid) from public;
revoke execute on function private.face_refresh_jobs(uuid) from public;
revoke execute on function private.liveness_challenge_face_jobs() from public;
revoke execute on function private.capture_face_jobs() from public;
revoke execute on function private.face_fail_job(uuid, text) from public;
revoke execute on function private.face_job_inputs(uuid) from public;
revoke execute on function private.face_details_valid(text, jsonb) from public;
revoke execute on function private.face_sweep() from public;
revoke execute on function private.face_match_review_only() from public;
revoke execute on function private.face_training_cases() from public;

revoke execute on function public.face_use_nonce(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.face_claim() from public, anon, authenticated;
revoke execute on function public.face_image_lookup(uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function public.face_job_context(uuid) from public, anon, authenticated;
revoke execute on function public.face_record_result(text, uuid, integer, text, text, public.check_outcome, numeric, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.flow_face_jobs_pending(uuid) from public, anon, authenticated;
grant execute on function public.face_use_nonce(text, text, timestamptz) to service_role;
grant execute on function public.face_claim() to service_role;
grant execute on function public.face_image_lookup(uuid, integer, uuid) to service_role;
grant execute on function public.face_job_context(uuid) to service_role;
grant execute on function public.face_record_result(text, uuid, integer, text, text, public.check_outcome, numeric, jsonb, jsonb)
  to service_role;
grant execute on function public.flow_face_jobs_pending(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cases already submitted are assessed again (the assessment gains reviewOnly).
-- ---------------------------------------------------------------------------
do $$
declare
  case_id uuid;
begin
  for case_id in select vv.id from public.verification vv where vv.status = 'submitted' order by vv.submitted_at, vv.id loop
    perform private.risk_refresh_safe(case_id, 'migration');
  end loop;
end $$;
