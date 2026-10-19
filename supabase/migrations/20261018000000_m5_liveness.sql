-- Confiance Verify — M5: active liveness capture (the face check). Capture only: nothing judges yet
-- whether the rider really did the actions (M6).
--   * liveness_challenge: one row per challenge the server issues to a session: three actions drawn at
--     random (turn the head left or right, look up, blink, smile), a one-time code shown on screen,
--     an expiry, and when it was used (once) or replaced by a newer one. Only the service role (the
--     `flow` Edge Function) can read or write it: the dashboard's roles get nothing, not even a grant.
--   * capture.liveness_challenge_id: the frames of a challenge are ordinary capture rows of kind
--     `liveness_frame`, in the same private bucket under the session's folder, so they are erased
--     with the session like the document photos (the rows cascade; the files share the folder). A
--     newer face check replaces the older frames as a newer photo replaces an older one (M3).
--   * check_result `liveness_capture` (one per case): whether the frames arrived complete and with
--     plausible timings, decided by the Edge Function. Codes, counts and timings only.
--   * RPCs for the `flow` Edge Function (service role only): flow_issue_liveness_challenge and
--     flow_record_liveness. Every change is audited (`liveness.challenge`, `liveness.capture`), never
--     with the code.
--   * consent_record.keep_face_images (PM, 2026-10-19): the rider's answer to a separate, optional box
--     "keep my face images to improve and tune Confiance's checks (deleted on request)", unticked by
--     default, with the version of that wording. Nothing depends on it yet.
-- Nothing is removed from the schema, and the text holds no removal statement: the deploy tools hang
-- on such statements (docs/HANDOFF.md).

-- ---------------------------------------------------------------------------
-- The optional "keep my face images" answer, with the version of its wording
-- ---------------------------------------------------------------------------
-- Consents recorded before M5 never showed the box: false, with no version.
alter table public.consent_record
  add column keep_face_images boolean not null default false,
  add column keep_face_images_version text,
  add constraint consent_record_keep_face_images_check
    check (not keep_face_images or keep_face_images_version is not null);

-- ---------------------------------------------------------------------------
-- Challenges
-- ---------------------------------------------------------------------------
-- The actions of contract.ts LIVENESS_ACTIONS, LIVENESS_LIMITS.actionsPerChallenge of them, all different.
-- A function, because a check constraint cannot hold a subquery.
create function private.liveness_actions_valid(p_actions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_actions is not null
     and cardinality(p_actions) = 3
     and array_position(p_actions, null) is null
     and p_actions <@ array['turn_left', 'turn_right', 'look_up', 'blink', 'smile']
     and (select count(distinct a) from unnest(p_actions) a) = 3
$$;

create table public.liveness_challenge (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verification (id) on delete cascade,
  -- In the order the rider performs them.
  actions          text[] not null check (private.liveness_actions_valid(actions)),
  -- Shown on screen during the capture and sent back with the frames (LIVENESS_LIMITS.codeDigits).
  code             text not null check (code ~ '^[0-9]{6}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  -- A newer challenge of the session replaced this one before it was used.
  superseded_at    timestamptz,
  -- Its frames were recorded: a challenge is used once.
  used_at          timestamptz,
  check (expires_at > created_at),
  check (used_at is null or superseded_at is null)
);
create index liveness_challenge_verification_idx on public.liveness_challenge (verification_id, created_at);

-- Service role only (the `flow` Edge Function). Staff see a challenge's actions and code in the
-- liveness_capture check once its frames are recorded, never an open challenge.
alter table public.liveness_challenge enable row level security;
revoke all on public.liveness_challenge from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Frames: capture rows of kind liveness_frame, tied to their challenge
-- ---------------------------------------------------------------------------
alter table public.capture
  add column liveness_challenge_id uuid references public.liveness_challenge (id) on delete cascade,
  add constraint capture_liveness_challenge_check
    check ((kind = 'liveness_frame') = (liveness_challenge_id is not null));
create index capture_liveness_challenge_idx on public.capture (liveness_challenge_id)
  where liveness_challenge_id is not null;

-- ---------------------------------------------------------------------------
-- Rider flow RPCs (called by the `flow` Edge Function with the service role)
-- ---------------------------------------------------------------------------

-- Issues a challenge drawn by the Edge Function: ('ok', id, expires_at); ('too_many', null, null) once
-- the session has had p_max challenges; ('closed', null, null) when the session is no longer open.
-- An unused earlier challenge of the session is replaced (it can no longer be recorded).
-- SECURITY DEFINER here and in flow_record_liveness: the table's check uses a private helper, which
-- the API roles (the service role included) cannot reach, as in M3.
create function public.flow_issue_liveness_challenge(
  p_verification uuid,
  p_actions text[],
  p_code text,
  p_ttl_seconds integer,
  p_max integer
)
returns table (result text, challenge_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_status public.verification_status;
  issued integer;
  new_id uuid;
  new_expiry timestamptz;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_max is null or p_max < 1 then
    raise exception 'flow_issue_liveness_challenge: invalid limits' using errcode = 'invalid_parameter_value';
  end if;
  -- The row lock serialises the session's challenges and frames (and a concurrent submit).
  select v.status into current_status from public.verification v where v.id = p_verification for update;
  if not found then
    raise exception 'verification % not found', p_verification using errcode = 'no_data_found';
  end if;
  if current_status not in ('created', 'in_progress') then
    return query select 'closed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into issued from public.liveness_challenge lc where lc.verification_id = p_verification;
  if issued >= p_max then
    return query select 'too_many'::text, null::uuid, null::timestamptz;
    return;
  end if;

  update public.liveness_challenge lc
     set superseded_at = now()
   where lc.verification_id = p_verification and lc.used_at is null and lc.superseded_at is null;

  insert into public.liveness_challenge (verification_id, actions, code, expires_at)
  values (p_verification, p_actions, p_code, now() + make_interval(secs => p_ttl_seconds))
  returning id, liveness_challenge.expires_at into new_id, new_expiry;

  -- Never the code: it is the challenge's only secret while it is open.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('rider', p_verification::text, 'liveness.challenge', 'liveness_challenge', new_id::text,
          jsonb_build_object('challengeNo', issued + 1, 'actions', to_jsonb(p_actions)));
  return query select 'ok'::text, new_id, new_expiry;
end;
$$;

-- Records the frames of a challenge, its liveness_capture check and one audit entry, all together or
-- not at all: ('ok', paths of the older frames it replaced, which the Edge Function removes from
-- storage). Otherwise nothing changes: 'not_found' (no such challenge in this session), 'used' (its
-- frames were already recorded), 'expired' (too late, or replaced by a newer challenge),
-- 'code_mismatch', 'closed' (the session was submitted meanwhile).
-- p_frames: [{index, step, atMs, path, sha256, byteSize, width, height}], already checked against the
-- files by the Edge Function; checked again here for shape. p_details: LivenessCaptureDetails, only its
-- keys, codes, counts and timings.
create function public.flow_record_liveness(
  p_verification uuid,
  p_challenge uuid,
  p_code text,
  p_frames jsonb,
  p_version text,
  p_outcome public.check_outcome,
  p_details jsonb
)
returns table (result text, superseded_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_status public.verification_status;
  ch public.liveness_challenge;
  frame jsonb;
  frame_count integer;
  path_re text;
  first_id uuid;
  inserted_id uuid;
  replaced text[];
begin
  -- Shape of what will be stored. The messages never repeat a value.
  if p_outcome is null or p_outcome not in ('pass', 'flag') or p_version is null or p_version !~ '^[a-z0-9.-]{1,40}$' then
    raise exception 'flow_record_liveness: unexpected outcome or version' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_details) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_details) k
                where k not in ('evaluated', 'challengeId', 'actions', 'code', 'frames', 'framesPerStep', 'durationMs',
                                'serverElapsedMs', 'maxGapMs', 'startedWithWarning', 'problems'))
     or (select count(*) from jsonb_object_keys(p_details)) <> 11
     or p_details -> 'evaluated' is distinct from 'false'::jsonb
     or jsonb_typeof(p_details -> 'startedWithWarning') is distinct from 'boolean'
     or jsonb_typeof(p_details -> 'problems') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_details -> 'problems') p
                where jsonb_typeof(p) <> 'string'
                   or p #>> '{}' not in ('too_fast', 'longer_than_challenge', 'gap_too_long', 'out_of_order',
                                         'step_missing_frames', 'duplicate_frames', 'frames_reused'))
     or jsonb_typeof(p_details -> 'framesPerStep') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_details -> 'framesPerStep') n where jsonb_typeof(n) <> 'number')
     or jsonb_typeof(p_details -> 'frames') is distinct from 'number'
     or jsonb_typeof(p_details -> 'durationMs') is distinct from 'number'
     or jsonb_typeof(p_details -> 'serverElapsedMs') is distinct from 'number'
     or jsonb_typeof(p_details -> 'maxGapMs') is distinct from 'number' then
    raise exception 'flow_record_liveness: unexpected details' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_frames) is distinct from 'array' then
    raise exception 'flow_record_liveness: frames are not a list' using errcode = 'invalid_parameter_value';
  end if;
  frame_count := jsonb_array_length(p_frames);
  if frame_count < 8 or frame_count > 15 then
    raise exception 'flow_record_liveness: unexpected number of frames' using errcode = 'invalid_parameter_value';
  end if;

  -- The session first (as flow_issue_liveness_challenge and flow_submit), then the challenge.
  select v.status into current_status from public.verification v where v.id = p_verification for update;
  if not found then
    raise exception 'verification % not found', p_verification using errcode = 'no_data_found';
  end if;
  if current_status not in ('created', 'in_progress') then
    return query select 'closed'::text, null::text[];
    return;
  end if;
  select * into ch from public.liveness_challenge lc
   where lc.id = p_challenge and lc.verification_id = p_verification
     for update;
  if not found then
    return query select 'not_found'::text, null::text[];
    return;
  end if;
  if ch.used_at is not null then
    return query select 'used'::text, null::text[];
    return;
  end if;
  if ch.superseded_at is not null or ch.expires_at <= now() then
    return query select 'expired'::text, null::text[];
    return;
  end if;
  if p_code is null or p_code <> ch.code then
    return query select 'code_mismatch'::text, null::text[];
    return;
  end if;

  -- The details describe this challenge and these frames.
  if p_details ->> 'challengeId' is distinct from ch.id::text
     or p_details -> 'actions' is distinct from to_jsonb(ch.actions)
     or p_details ->> 'code' is distinct from ch.code
     or (p_details ->> 'frames')::numeric is distinct from frame_count
     or jsonb_array_length(p_details -> 'framesPerStep') <> cardinality(ch.actions) + 1 then
    raise exception 'flow_record_liveness: details do not match the challenge' using errcode = 'invalid_parameter_value';
  end if;

  -- Each frame: its own slot of this challenge, in this session's folder, numbered 0..n-1 once each.
  path_re := '^' || p_verification::text || '/liveness-' || ch.id::text || '-[0-9]{2}\.jpg$';
  if exists (
       select 1 from jsonb_array_elements(p_frames) f
       where jsonb_typeof(f) <> 'object'
          or coalesce(f ->> 'path', '') !~ path_re
          or coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(f -> 'index') <> 'number' or jsonb_typeof(f -> 'step') <> 'number'
          or jsonb_typeof(f -> 'atMs') <> 'number' or jsonb_typeof(f -> 'byteSize') <> 'number'
          or jsonb_typeof(f -> 'width') <> 'number' or jsonb_typeof(f -> 'height') <> 'number'
          or (f ->> 'byteSize')::numeric not between 2000 and 100000
          or greatest((f ->> 'width')::numeric, (f ->> 'height')::numeric) not between 240 and 640
          or (f ->> 'step')::numeric not between 0 and cardinality(ch.actions)
          or (f ->> 'atMs')::numeric not between 0 and 60000
          or right(f ->> 'path', 6) <> lpad(f ->> 'index', 2, '0') || '.jpg')
     or (select count(distinct (f ->> 'index')::numeric) from jsonb_array_elements(p_frames) f) <> frame_count
     or (select min((f ->> 'index')::numeric) from jsonb_array_elements(p_frames) f) <> 0
     or (select max((f ->> 'index')::numeric) from jsonb_array_elements(p_frames) f) <> frame_count - 1
     or (select sum((f ->> 'byteSize')::numeric) from jsonb_array_elements(p_frames) f) > 600000 then
    raise exception 'flow_record_liveness: unexpected frames' using errcode = 'invalid_parameter_value';
  end if;

  for frame in select f from jsonb_array_elements(p_frames) f order by (f ->> 'index')::numeric loop
    insert into public.capture (verification_id, kind, storage_path, sha256, mime_type, byte_size, width, height,
                                quality, liveness_challenge_id)
    values (p_verification, 'liveness_frame', frame ->> 'path', frame ->> 'sha256', 'image/jpeg',
            (frame ->> 'byteSize')::integer, (frame ->> 'width')::integer, (frame ->> 'height')::integer,
            jsonb_build_object(
              'liveness', jsonb_build_object('index', (frame ->> 'index')::integer, 'step', (frame ->> 'step')::integer,
                                             'atMs', (frame ->> 'atMs')::integer),
              'server', jsonb_build_object('validated', true)),
            ch.id)
    returning id into inserted_id;
    first_id := coalesce(first_id, inserted_id);
  end loop;

  -- The frames of an earlier face check of this session are replaced (erased; the Edge Function
  -- removes their files), as an older photo of a side is (M3).
  with older as (
    update public.capture c
       set deleted_at = now(), superseded_by = first_id
     where c.verification_id = p_verification and c.kind = 'liveness_frame'
       and c.deleted_at is null and c.liveness_challenge_id <> ch.id
    returning c.storage_path
  )
  select coalesce(array_agg(o.storage_path order by o.storage_path), '{}') into replaced from older o;

  update public.liveness_challenge lc set used_at = now() where lc.id = ch.id;

  -- 'liveness_capture' is LIVENESS_CHECK_NAME in contract.ts: one per case (check_result_case_check_idx).
  insert into public.check_result (verification_id, check_name, check_version, outcome, details)
  values (p_verification, 'liveness_capture', p_version, p_outcome, p_details)
  on conflict (verification_id, check_name) where capture_id is null
  do update set check_version = excluded.check_version, outcome = excluded.outcome,
                details = excluded.details, created_at = now();

  -- Counts and outcomes only: never the code.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('rider', p_verification::text, 'liveness.capture', 'liveness_challenge', ch.id::text,
          jsonb_build_object('frames', frame_count, 'outcome', p_outcome, 'replaced', cardinality(replaced),
                             'problems', p_details -> 'problems'));
  return query select 'ok'::text, replaced;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the RPCs are for the service role only; the helper for the table's check only
-- ---------------------------------------------------------------------------
revoke execute on function private.liveness_actions_valid(text[]) from public;
revoke execute on function public.flow_issue_liveness_challenge(uuid, text[], text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)
  from public, anon, authenticated;
grant execute on function public.flow_issue_liveness_challenge(uuid, text[], text, integer, integer) to service_role;
grant execute on function public.flow_record_liveness(uuid, uuid, text, jsonb, text, public.check_outcome, jsonb)
  to service_role;
