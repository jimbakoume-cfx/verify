-- Confiance Verify — M3: the AI worker re-checks the photos on the server.
--   * worker_job: one job per document photo (front or back), created by a trigger on capture. The
--     AI worker (a Python function on Vercel) claims jobs through the `worker` Edge Function, fetches
--     the photo through it, and posts its evidence back; the Edge Function decides and records the
--     results here. The worker never talks to the database and holds no Supabase credential.
--   * A newer photo of a side supersedes the older one: the older photo is marked erased (the flow
--     function removes the object from storage), the data read from it is deleted and its unfinished
--     job is dropped. Only the newest live photo of each side counts.
--   * worker_key / worker_nonce: the worker signs every request with Ed25519. The public keys live here
--     (so a key can be rotated or revoked) and each request's nonce is accepted once (replay guard).
--   * worker_settings: the test-only switch and the daily job cap. Vercel's Hobby plan is for
--     non-commercial use and has 4 CPU-hours a month: until Pro and its DPA, only test sessions are
--     processed.
--   * check_result: per-photo server checks (quality_server, mrz_server, ocr_fields) and per-case
--     checks (classification, document_policy), at most one of each per case.
--   * extracted_document_data: the code lines read by the server (mrz_server) and the printed fields
--     (ocr_server), encrypted under the same Vault key as the phone's lines.
--   * private.worker_sweep(), every minute through pg_cron: requeues jobs whose worker vanished, gives
--     up after 3 attempts, rings the worker through pg_net while work waits, purges old nonces and
--     old cron logs.
--
-- Who decides what. The Edge Function decides everything that comes from the photos (quality
-- verdict, code lines, classification, the reasons a person must look). The database adds the reasons
-- that follow from events it records itself: the server could not check a photo (server_unchecked),
-- the phone's report of the code lines is missing or disagrees with the server's reading
-- (phone_report_missing, mrz_disagreement). Whichever of the phone's report and the server's reading
-- lands second compares the two lines, here, where both can be decrypted.
--
-- Concurrency. Every write that changes a case's server checks first takes the case's advisory lock
-- (private.worker_lock_case), then touches rows: one lock order everywhere, so writers queue instead of
-- deadlocking. The Edge Function decides the case-level checks from a snapshot of the case
-- (worker_case_snapshot); the write is refused as 'stale' when the snapshot changed in between (two
-- photos of a case finishing at the same moment), and the function decides again.

-- ---------------------------------------------------------------------------
-- Extensions: pg_net (HTTP from the database) and pg_cron (the scheduler)
-- ---------------------------------------------------------------------------
-- Guarded, so the migration still applies on plain PostgreSQL (CI and local tests). There, the test
-- stub provides stand-ins for net.http_post and cron.schedule, which the code below looks up by name.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
end $$;

-- Where the sweep rings the worker: the production alias of the Vercel function. Public (the ring
-- carries no authority), kept in Vault so it can change without a migration. Created only once.
do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'worker_ring_url') then
    perform vault.create_secret(
      'https://confiance-verify-worker.vercel.app/api/process',
      'worker_ring_url',
      'Doorbell of the AI worker, rung by private.worker_sweep() through pg_net. Public URL; a ring carries no authority.'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Settings: the test-only switch and the daily budget
-- ---------------------------------------------------------------------------
create table public.worker_settings (
  -- A single row: the key can only be true.
  id                         boolean primary key default true check (id),
  -- Off until Vercel Pro and its DPA are in place: until then the worker processes test sessions only.
  -- Turn on with: update public.worker_settings set enabled_for_real_sessions = true, updated_at = now();
  enabled_for_real_sessions  boolean not null default false,
  -- Jobs started per day (Douala time). Beyond it, jobs end 'failed' with code 'budget': the rider
  -- continues and staff review. Protects the monthly CPU budget from a flood of uploads.
  daily_job_cap              integer not null default 150 check (daily_job_cap >= 0),
  updated_at                 timestamptz not null default now()
);
insert into public.worker_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- The worker's signing keys and the nonces it has used
-- ---------------------------------------------------------------------------
-- Add a key: insert into public.worker_key (kid, public_key) values ('<kid>', '<base64url public key>');
-- Revoke it: update public.worker_key set revoked_at = now() where kid = '<kid>';
create table public.worker_key (
  kid         text primary key check (kid ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- base64url (no padding) of the 32 raw bytes of the Ed25519 public key. Public by nature.
  public_key  text not null unique check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- One row per signed request accepted, kept while its timestamp could still be accepted.
create table public.worker_nonce (
  nonce       text primary key check (nonce ~ '^[0-9a-f]{32}$'),
  expires_at  timestamptz not null
);
create index worker_nonce_expires_idx on public.worker_nonce (expires_at);

-- ---------------------------------------------------------------------------
-- Photos replaced by a newer photo of the same side
-- ---------------------------------------------------------------------------
alter table public.capture
  add column superseded_by uuid references public.capture (id) on delete set null,
  -- A replaced photo is erased: its object is removed from storage by the flow function.
  add constraint capture_superseded_is_erased check (superseded_by is null or deleted_at is not null);
create index capture_superseded_by_idx on public.capture (superseded_by) where superseded_by is not null;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create table public.worker_job (
  id                uuid primary key default gen_random_uuid(),
  capture_id        uuid not null unique references public.capture (id) on delete cascade,
  verification_id   uuid not null references public.verification (id) on delete cascade,
  kind              public.capture_kind not null check (kind in ('document_front', 'document_back')),
  -- pending: waiting for the worker. claimed: a worker holds the lease. done: its result is recorded
  -- (the first result wins). failed: given up (error_code says why). superseded: a newer photo of the
  -- side replaced this one before it was done.
  status            text not null default 'pending'
                      check (status in ('pending', 'claimed', 'done', 'failed', 'superseded')),
  -- Claims so far; the job fails after the third.
  attempts          integer not null default 0 check (attempts between 0 and 3),
  lease_until       timestamptz,
  -- The first claim counts against the daily cap.
  first_claimed_at  timestamptz,
  -- budget: over the daily cap. ineligible: a real session while the switch is off, or a session that
  -- is no longer open. attempts: three claims without a result. expired: not done within an hour.
  error_code        text check (error_code in ('budget', 'ineligible', 'attempts', 'expired')),
  -- The flow function could not ring the worker for this photo: the rider is not kept waiting.
  ring_failed_at    timestamptz,
  -- What the Edge Function kept from the worker's result to decide the case-level checks: generic
  -- codes, counts and flags, never a value read from the document. Not readable by staff.
  evidence          jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status = 'failed') = (error_code is not null)),
  check ((status = 'claimed') = (lease_until is not null)),
  check ((status = 'done') = (evidence is not null))
);
-- Claimable jobs, oldest first.
create index worker_job_queue_idx on public.worker_job (created_at) where status in ('pending', 'claimed');
create index worker_job_verification_idx on public.worker_job (verification_id, kind);
create index worker_job_first_claimed_idx on public.worker_job (first_claimed_at) where first_claimed_at is not null;

-- No grant for the dashboard's roles: the Edge Functions use the service role.
alter table public.worker_settings enable row level security;
alter table public.worker_key      enable row level security;
alter table public.worker_nonce    enable row level security;
alter table public.worker_job      enable row level security;
revoke all on public.worker_settings, public.worker_key, public.worker_nonce, public.worker_job
  from anon, authenticated;
-- One narrow exception: staff read whether each photo's job is waiting, done or failed, so the case page
-- shows "Waiting for the server" or "Not checked" per photo (a photo taken before M3 has no job at all).
-- Only these three columns, never the evidence, attempts, leases or error codes; and the same rule as for
-- the photos themselves.
grant select (capture_id, verification_id, status) on public.worker_job to authenticated;
create policy "supervisors see all, reviewers see assigned" on public.worker_job
  for select to authenticated
  using ((select private.is_staff_at_least('supervisor')) or private.is_assigned_reviewer(verification_id));

-- ---------------------------------------------------------------------------
-- Data read by the server
-- ---------------------------------------------------------------------------
-- mrz_server: the code lines read from the photo by the worker (after the shared corrector), joined
-- with a newline. ocr_server: the printed fields read by the worker, as a JSON object (WorkerFields,
-- including the card sub-type, which never appears anywhere else). Both encrypted like mrz_phone.
alter table public.extracted_document_data drop constraint extracted_document_data_source_check;
alter table public.extracted_document_data drop constraint extracted_document_data_format_check;
alter table public.extracted_document_data alter column format drop not null;
alter table public.extracted_document_data
  add constraint extracted_document_data_source_check
    check (source in ('mrz_phone', 'mrz_server', 'ocr_server')),
  -- Code lines have a format; printed fields have none.
  add constraint extracted_document_data_format_check
    check ((source = 'ocr_server' and format is null)
        or (source in ('mrz_phone', 'mrz_server') and format is not null and format in ('TD1', 'TD3')));

-- ---------------------------------------------------------------------------
-- Checks of a whole case: one row per check (the per-photo rule is check_result_capture_check_idx)
-- ---------------------------------------------------------------------------
create unique index check_result_case_check_idx
  on public.check_result (verification_id, check_name) where capture_id is null;

-- ---------------------------------------------------------------------------
-- Private helpers (not exposed through the API; called by the functions below)
-- ---------------------------------------------------------------------------
create function private.worker_case_key(p_verification uuid)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select hashtextextended('worker_case:' || p_verification::text, 0)
$$;

-- Serialises every writer of a case's server checks until the end of the transaction.
create function private.worker_lock_case(p_verification uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(private.worker_case_key(p_verification));
end;
$$;

-- The newest live photo of each document side of a case.
create function private.worker_newest_captures(p_verification uuid)
returns table (capture_id uuid, kind public.capture_kind)
language sql
stable
set search_path = ''
as $$
  select distinct on (c.kind) c.id, c.kind
  from public.capture c
  where c.verification_id = p_verification
    and c.deleted_at is null
    and c.kind in ('document_front', 'document_back')
  order by c.kind, c.created_at desc, c.id desc
$$;

-- Everything the Edge Function's case-level decision depends on: the declared document and, for the
-- newest live photo of each side, the evidence of its finished job. Null for an unknown case.
create function private.worker_case_inputs(p_verification uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'declaredDocument', v.declared_document,
    'sides', coalesce((
      select jsonb_agg(jsonb_build_object('kind', n.kind, 'captureId', n.capture_id, 'evidence', j.evidence)
                       order by n.kind)
      from private.worker_newest_captures(v.id) n
      left join public.worker_job j on j.capture_id = n.capture_id and j.status = 'done'
    ), '[]'::jsonb))
  from public.verification v
  where v.id = p_verification
$$;

-- The reasons that follow from what the database records (the sides' jobs and the phone's report),
-- sorted. Every other reason is decided by the Edge Function from the photos.
create function private.worker_status_reasons(p_verification uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(r.reason order by r.reason), '{}')
  from (
    select 'server_unchecked' as reason
    where exists (
      select 1 from private.worker_newest_captures(p_verification) n
      join public.worker_job j on j.capture_id = n.capture_id
      where j.status = 'failed')
    union all
    select 'phone_report_missing'
    where exists (
      select 1 from private.worker_newest_captures(p_verification) n
      join public.check_result cr on cr.capture_id = n.capture_id and cr.check_name = 'mrz_server'
      where cr.details ->> 'phone' = 'missing')
    union all
    select 'mrz_disagreement'
    where exists (
      select 1 from private.worker_newest_captures(p_verification) n
      join public.check_result cr on cr.capture_id = n.capture_id and cr.check_name = 'mrz_server'
      where cr.details ->> 'phone' = 'differs' and cr.details ->> 'found' = 'true')
  ) r
$$;

-- Rewrites document_policy: the Edge Function's reasons (p_case_reasons; null keeps the stored ones)
-- plus the status reasons, recomputed now. The row exists while the case has a classification or a
-- reason. The caller holds the case lock.
create function private.worker_refresh_policy(
  p_verification uuid,
  p_case_reasons text[] default null,
  p_version text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  status_codes constant text[] := array['mrz_disagreement', 'phone_report_missing', 'server_unchecked'];
  stored public.check_result;
  decided text[];
  reasons text[];
begin
  select * into stored from public.check_result cr
   where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'document_policy';
  decided := coalesce(p_case_reasons,
                      array(select jsonb_array_elements_text(coalesce(stored.details -> 'reasons', '[]'::jsonb))));
  reasons := array(
    select distinct r from unnest(
      array(select d from unnest(decided) d where d <> all (status_codes))
      || private.worker_status_reasons(p_verification)) r
    order by r);

  if cardinality(reasons) = 0 and not exists (
    select 1 from public.check_result cr
    where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'classification'
  ) then
    delete from public.check_result cr
     where cr.verification_id = p_verification and cr.capture_id is null and cr.check_name = 'document_policy';
    return;
  end if;

  insert into public.check_result (verification_id, check_name, check_version, outcome, details)
  values (p_verification, 'document_policy', coalesce(p_version, stored.check_version, 'server-checks-v1'),
          case when cardinality(reasons) = 0 then 'pass' else 'flag' end::public.check_outcome,
          jsonb_build_object('reasons', to_jsonb(reasons)))
  on conflict (verification_id, check_name) where capture_id is null
  do update set check_version = excluded.check_version, outcome = excluded.outcome,
                details = excluded.details, created_at = now();
end;
$$;

-- Writes the case-level checks decided by the Edge Function: {version, classification: {outcome,
-- score, details} or null, reasons: [...]}. Null: no photo of the case has a server result any more.
-- The classification's details may hold only the keys of ClassificationDetails (contract.ts
-- CLASSIFICATION_DETAIL_KEYS): supervisors and admins read check_result, and anything more, such as
-- the keyword counts that tell a Cameroonian passport from a foreign one, stays in worker_job.evidence.
-- The caller holds the case lock.
create function private.worker_apply_case(p_verification uuid, p_case jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  cls jsonb := p_case -> 'classification';
begin
  if cls is not null and jsonb_typeof(cls) <> 'null' and (
       jsonb_typeof(cls -> 'details') is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(cls -> 'details') k
                  where k not in ('detected', 'basis', 'provisional', 'matchesDeclared', 'confidence', 'qrPresent'))) then
    raise exception 'worker_apply_case: unexpected classification details' using errcode = 'invalid_parameter_value';
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
  perform private.worker_refresh_policy(
    p_verification,
    coalesce(array(select jsonb_array_elements_text(coalesce(p_case -> 'reasons', '[]'::jsonb))), '{}'),
    p_case ->> 'version');
end;
$$;

-- Gives up on a job: audited (code only), and the case's status reasons are refreshed.
-- The caller holds the case lock.
create function private.worker_fail_job(p_job uuid, p_code text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  j public.worker_job;
begin
  update public.worker_job wj
     set status = 'failed', error_code = p_code, lease_until = null, updated_at = now()
   where wj.id = p_job
  returning * into j;
  insert into public.audit_event (actor_type, action, target_type, target_id, details)
  values ('system', 'worker.job_failed', 'verification', j.verification_id::text,
          jsonb_build_object('jobId', j.id, 'captureId', j.capture_id, 'code', p_code, 'attempts', j.attempts));
  perform private.worker_refresh_policy(j.verification_id);
end;
$$;

-- How the phone's reading of a photo's code lines compares with the server's: 'missing' (no report
-- yet), 'unreadable' (the phone read nothing), 'agrees' (the same lines) or 'differs' (the server did
-- not read these lines). Runs inside the SECURITY DEFINER functions below, which may read Vault.
create function private.mrz_phone_agreement(p_capture uuid, p_server_lines text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  phone public.check_result;
  phone_lines text;
begin
  -- 'mrz' is MRZ_CHECK_NAME in contract.ts: the phone's report.
  select * into phone from public.check_result cr where cr.capture_id = p_capture and cr.check_name = 'mrz';
  if not found then
    return 'missing';
  end if;
  if phone.details ->> 'result' = 'unreadable' then
    return 'unreadable';
  end if;
  select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret) into phone_lines
    from public.extracted_document_data edd
    join vault.decrypted_secrets ds on ds.name = edd.key_name
   where edd.capture_id = p_capture and edd.source = 'mrz_phone';
  if p_server_lines is not null and phone_lines is not null and phone_lines = p_server_lines then
    return 'agrees';
  end if;
  return 'differs';
end;
$$;

-- ---------------------------------------------------------------------------
-- A job for every new document photo; the photo it replaces is superseded
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: it writes worker tables whatever role inserts the photo.
create function private.capture_worker_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  replaced integer;
  eligible boolean;
begin
  perform private.worker_lock_case(new.verification_id);

  -- Older live photos of this side: erased (the flow function removes their objects) and replaced.
  update public.capture c
     set deleted_at = now(), superseded_by = new.id
   where c.verification_id = new.verification_id and c.kind = new.kind
     and c.id <> new.id and c.deleted_at is null;
  get diagnostics replaced = row_count;
  if replaced > 0 then
    -- The data read from a replaced photo goes with it, as for a refused upload (M1).
    delete from public.extracted_document_data edd
     using public.capture c
     where c.superseded_by = new.id and edd.capture_id = c.id;
  end if;
  update public.worker_job j
     set status = 'superseded', lease_until = null, updated_at = now()
   where j.verification_id = new.verification_id and j.kind = new.kind and j.status in ('pending', 'claimed');

  -- Real sessions wait for the switch; their photos are marked unchecked at once.
  select v.is_test or coalesce((select ws.enabled_for_real_sessions from public.worker_settings ws), false)
    into eligible
    from public.verification v where v.id = new.verification_id;
  insert into public.worker_job (capture_id, verification_id, kind, status, error_code)
  values (new.id, new.verification_id, new.kind,
          case when eligible then 'pending' else 'failed' end,
          case when eligible then null else 'ineligible' end);

  if replaced > 0 or not eligible then
    perform private.worker_refresh_policy(new.verification_id);
  end if;
  return null;
end;
$$;

-- A photo inserted already erased (a fixture, a restore) replaces nothing and needs no job.
create trigger capture_worker_job
  after insert on public.capture
  for each row
  when (new.kind in ('document_front', 'document_back') and new.deleted_at is null)
  execute function private.capture_worker_job();

-- ---------------------------------------------------------------------------
-- Worker RPCs (called by the `worker` Edge Function, service role)
-- ---------------------------------------------------------------------------
-- Accepts a signed request's nonce once: 'ok', 'replayed' (seen before) or 'revoked' (the key was
-- revoked or removed after the function looked it up). Called after the signature is verified, so
-- unsigned requests cannot fill the table.
create function public.worker_use_nonce(p_kid text, p_nonce text, p_expires_at timestamptz)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.worker_key k where k.kid = p_kid and k.revoked_at is null) then
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

-- Hands out the oldest claimable job (pending, or claimed with an expired lease), or no row.
-- On the way, jobs that may not run are given up: 3 attempts used, a session that is not eligible
-- (real while the switch is off, closed, or expired before submit), or the daily cap reached.
-- Lease 120 s. The claim lock serialises claims, so the cap is exact; a case another writer holds is
-- skipped (its job is picked up by the next claim) rather than waited for.
-- SECURITY DEFINER: it writes the audit log through private.worker_fail_job whatever the caller.
create function public.worker_claim()
returns table (
  job_id uuid, attempt integer, capture_id uuid, kind text, declared_document text,
  sha256 text, byte_size integer, width integer, height integer
)
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
  code text;
begin
  perform pg_advisory_xact_lock(hashtextextended('worker_claim', 0));
  select * into settings from public.worker_settings ws where ws.id;
  if not found then
    return; -- No settings row: fail closed.
  end if;
  select count(*) into started from public.worker_job wj where wj.first_claimed_at >= day_start;

  for cand in
    select wj.id, wj.verification_id
      from public.worker_job wj
     where wj.status = 'pending' or (wj.status = 'claimed' and wj.lease_until < now())
     order by wj.created_at, wj.id
     limit 100
  loop
    continue when not pg_try_advisory_xact_lock(private.worker_case_key(cand.verification_id));
    select wj.status, wj.attempts, wj.lease_until, wj.first_claimed_at, wj.capture_id, wj.kind,
           c.deleted_at, c.sha256, c.byte_size, c.width, c.height,
           v.status as session_status, v.is_test, v.session_expires_at, v.declared_document
      into r
      from public.worker_job wj
      join public.capture c on c.id = wj.capture_id
      join public.verification v on v.id = wj.verification_id
     where wj.id = cand.id
       for update of wj;
    -- Re-checked under the lock: another writer may have finished or replaced it meanwhile.
    continue when not (r.status = 'pending' or (r.status = 'claimed' and r.lease_until < now()));
    if r.deleted_at is not null then
      update public.worker_job wj set status = 'superseded', lease_until = null, updated_at = now()
       where wj.id = cand.id;
      continue;
    end if;

    code := case
      when r.attempts >= 3 then 'attempts'
      when r.declared_document is null
        or not (r.session_status = 'submitted'
                or (r.session_status = 'in_progress' and r.session_expires_at > now()))
        or not (r.is_test or settings.enabled_for_real_sessions) then 'ineligible'
      when r.first_claimed_at is null and started >= settings.daily_job_cap then 'budget'
    end;
    if code is not null then
      perform private.worker_fail_job(cand.id, code);
      continue;
    end if;

    update public.worker_job wj
       set status = 'claimed', attempts = wj.attempts + 1, lease_until = now() + interval '120 seconds',
           first_claimed_at = coalesce(wj.first_claimed_at, now()), updated_at = now()
     where wj.id = cand.id;
    return query select cand.id, r.attempts + 1, r.capture_id, r.kind::text, r.declared_document,
                        r.sha256, r.byte_size, r.width, r.height;
    return;
  end loop;
end;
$$;

-- Where to read the photo of a claimed job: 'ok' with the storage path for the attempt holding the
-- lease; 'gone' when the photo was replaced or erased; 'not_found' for anything else (unknown job,
-- another attempt, a job not claimed).
create function public.worker_image_lookup(p_job uuid, p_attempt integer)
returns table (result text, capture_id uuid, verification_id uuid, storage_path text, byte_size integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  j public.worker_job;
  c public.capture;
begin
  select * into j from public.worker_job wj where wj.id = p_job;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text, null::integer;
    return;
  end if;
  select * into c from public.capture cc where cc.id = j.capture_id;
  if j.status = 'superseded' or c.deleted_at is not null then
    return query select 'gone'::text, null::uuid, null::uuid, null::text, null::integer;
    return;
  end if;
  if j.status <> 'claimed' or j.attempts is distinct from p_attempt then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text, null::integer;
    return;
  end if;
  return query select 'ok'::text, c.id, c.verification_id, c.storage_path, c.byte_size;
end;
$$;

-- What the Edge Function needs to decide: the case inputs (private.worker_case_inputs), their
-- fingerprint, and, when p_job is given, that job's state. Null for an unknown job or case.
-- SECURITY DEFINER here and in worker_write_case: they use the private helpers, which the API roles
-- (the service role included) cannot reach.
create function public.worker_case_snapshot(p_verification uuid default null, p_job uuid default null)
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
  return inputs || jsonb_build_object('verificationId', target, 'fingerprint', md5(inputs::text), 'job', job);
end;
$$;

-- Records a worker's result: the per-photo checks, the encrypted code lines and printed fields, the
-- job's evidence, the case-level checks and one audit entry, all together or not at all.
--   'recorded'; 'already_done' (an earlier result for this job won; nothing changes); 'stale' (the case
--   changed since the snapshot p_fingerprint came from; nothing written, decide again); 'gone' (the
--   photo was replaced or erased); 'not_found' (unknown job, or an attempt never handed out).
-- p_capture_checks: [{name, version, outcome, details}] for quality_server, ocr_fields and, on the side
-- that carries the code lines, mrz_server (its details.phone is filled in here). p_mrz_lines: the
-- lines joined with a newline, when the expected code lines were read. p_fields: WorkerFields as a JSON
-- object, when any was read. Neither ever appears in an error message.
-- SECURITY DEFINER: it reads the key from Vault, which the API roles cannot read.
create function public.worker_record_result(
  p_kid text,
  p_job uuid,
  p_attempt integer,
  p_fingerprint text,
  p_capture_checks jsonb,
  p_evidence jsonb,
  p_case jsonb,
  p_mrz_lines text,
  p_mrz_format text,
  p_fields text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.worker_job;
  c public.capture;
  doc_key text;
  -- AES-256, as flow_record_mrz (a named constant keeps the option away from the key's name).
  pgp_options constant text := 'cipher-algo=aes256';
  chk jsonb;
  details jsonb;
  outcomes jsonb := '{}'::jsonb;
begin
  if p_mrz_lines is not null and not coalesce(
       (p_mrz_format = 'TD1' and p_mrz_lines ~ '^[A-Z0-9<]{30}\n[A-Z0-9<]{30}\n[A-Z0-9<]{30}$')
    or (p_mrz_format = 'TD3' and p_mrz_lines ~ '^[A-Z0-9<]{44}\n[A-Z0-9<]{44}$'), false) then
    raise exception 'worker_record_result: lines do not match the format' using errcode = 'invalid_parameter_value';
  end if;
  if p_fields is not null and not (p_fields is json object) then
    raise exception 'worker_record_result: fields are not a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  select * into j from public.worker_job wj where wj.id = p_job;
  if not found then
    return 'not_found';
  end if;
  perform private.worker_lock_case(j.verification_id);
  select * into j from public.worker_job wj where wj.id = p_job for update;
  if p_attempt is null or p_attempt < 1 or p_attempt > j.attempts then
    return 'not_found';
  end if;
  if j.status = 'done' then
    return 'already_done';
  end if;
  select * into c from public.capture cc where cc.id = j.capture_id for update;
  if j.status = 'superseded' or c.deleted_at is not null then
    return 'gone';
  end if;
  -- pending (its lease expired and it was requeued), claimed or failed (given up, then a late result):
  -- the first result wins either way.
  if md5(private.worker_case_inputs(j.verification_id)::text) is distinct from p_fingerprint then
    return 'stale';
  end if;

  if p_mrz_lines is not null or p_fields is not null then
    select ds.decrypted_secret into doc_key from vault.decrypted_secrets ds where ds.name = 'document_data_key_v1';
    if doc_key is null then
      raise exception 'worker_record_result: the key document_data_key_v1 is missing from Vault';
    end if;
  end if;
  if p_mrz_lines is not null then
    insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
    values (j.verification_id, c.id, 'mrz_server', p_mrz_format,
            extensions.pgp_sym_encrypt(p_mrz_lines, doc_key, pgp_options), 'document_data_key_v1');
  end if;
  if p_fields is not null then
    insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
    values (j.verification_id, c.id, 'ocr_server', null,
            extensions.pgp_sym_encrypt(p_fields, doc_key, pgp_options), 'document_data_key_v1');
  end if;

  for chk in select * from jsonb_array_elements(p_capture_checks) loop
    if chk ->> 'name' is null or chk ->> 'name' not in ('quality_server', 'mrz_server', 'ocr_fields') then
      raise exception 'worker_record_result: unknown per-photo check' using errcode = 'invalid_parameter_value';
    end if;
    details := chk -> 'details';
    if chk ->> 'name' = 'mrz_server' then
      -- The phone's report may already be here: compare now (if not, flow_record_mrz compares later).
      details := jsonb_set(details, '{phone}', to_jsonb(private.mrz_phone_agreement(c.id, p_mrz_lines)));
    end if;
    insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
    values (j.verification_id, c.id, chk ->> 'name', chk ->> 'version', (chk ->> 'outcome')::public.check_outcome,
            details);
    outcomes := outcomes || jsonb_build_object(chk ->> 'name', chk ->> 'outcome');
  end loop;

  update public.worker_job wj
     set status = 'done', error_code = null, lease_until = null, evidence = p_evidence, updated_at = now()
   where wj.id = j.id;
  perform private.worker_apply_case(j.verification_id, p_case);

  -- Outcomes only: nothing read from the document goes into the audit log.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('system', p_kid, 'worker.result', 'verification', j.verification_id::text,
          jsonb_build_object('jobId', j.id, 'captureId', c.id, 'attempt', p_attempt, 'checks', outcomes));
  return 'recorded';
end;
$$;

-- Rewrites a case's checks decided by the Edge Function without a new result (after a photo was
-- replaced): 'ok', 'stale' (decide again) or 'not_found'.
create function public.worker_write_case(p_verification uuid, p_fingerprint text, p_case jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inputs jsonb;
begin
  perform private.worker_lock_case(p_verification);
  inputs := private.worker_case_inputs(p_verification);
  if inputs is null then
    return 'not_found';
  end if;
  if md5(inputs::text) is distinct from p_fingerprint then
    return 'stale';
  end if;
  perform private.worker_apply_case(p_verification, p_case);
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- The sweep (pg_cron, every minute)
-- ---------------------------------------------------------------------------
-- Requeues jobs whose lease expired (the worker crashed or timed out), gives up on a job after 3
-- attempts or when it is not done within an hour, rings the worker while jobs wait, and purges
-- expired nonces and week-old cron logs. Returns counts, for the logs and the tests.
-- SECURITY DEFINER: it reads the ring URL from Vault.
create function private.worker_sweep()
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
  purged integer;
begin
  for j in
    select wj.id, wj.verification_id
      from public.worker_job wj
     where (wj.status = 'claimed' and wj.lease_until < now())
        or (wj.status in ('pending', 'claimed') and wj.created_at < now() - interval '1 hour')
     order by wj.created_at
     limit 500
  loop
    -- A case another writer holds is left for the next sweep.
    continue when not pg_try_advisory_xact_lock(private.worker_case_key(j.verification_id));
    if exists (select 1 from public.worker_job wj
               where wj.id = j.id and wj.status in ('pending', 'claimed') and wj.created_at < now() - interval '1 hour'
                 and (wj.status = 'pending' or wj.lease_until < now())) then
      perform private.worker_fail_job(j.id, 'expired');
      failed := failed + 1;
    elsif exists (select 1 from public.worker_job wj
                  where wj.id = j.id and wj.status = 'claimed' and wj.lease_until < now() and wj.attempts >= 3) then
      perform private.worker_fail_job(j.id, 'attempts');
      failed := failed + 1;
    else
      update public.worker_job wj
         set status = 'pending', lease_until = null, updated_at = now()
       where wj.id = j.id and wj.status = 'claimed' and wj.lease_until < now();
      if found then
        requeued := requeued + 1;
      end if;
    end if;
  end loop;

  -- A ring carries no authority: the worker claims whatever is due. pg_net keeps the response 6 h.
  if exists (select 1 from public.worker_job wj where wj.status = 'pending') then
    select ds.decrypted_secret into ring_url from vault.decrypted_secrets ds where ds.name = 'worker_ring_url';
    if ring_url is not null and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null then
      -- The worker answers after its run (at most about 50 s); the timeout lets it finish.
      perform net.http_post(
        url := ring_url,
        body := '{}'::jsonb,
        headers := '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds := 60000);
      rung := true;
    end if;
  end if;

  delete from public.worker_nonce wn where wn.expires_at < now();
  get diagnostics purged = row_count;
  if to_regclass('cron.job_run_details') is not null then
    execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
  end if;

  return jsonb_build_object('requeued', requeued, 'failed', failed, 'rung', rung, 'noncesPurged', purged);
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('worker-sweep', '* * * * *', 'select private.worker_sweep()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Rider flow (called by the `flow` Edge Function, service role)
-- ---------------------------------------------------------------------------
-- Every document photo of a case, with its job and what GET /flow/checks needs: the server's quality
-- verdict and whether the phone read every check digit of its code lines right.
create function public.flow_check_state(p_verification uuid)
returns table (
  capture_id uuid, kind text, live boolean, created_at timestamptz, job_status text, job_error text,
  ring_failed boolean, quality_verdict text, phone_mrz_pass boolean
)
language sql
stable
set search_path = ''
as $$
  select c.id, c.kind::text, c.deleted_at is null, c.created_at, j.status, j.error_code,
         j.ring_failed_at is not null, q.details ->> 'verdict', m.outcome = 'pass'
  from public.capture c
  left join public.worker_job j on j.capture_id = c.id
  left join public.check_result q on q.capture_id = c.id and q.check_name = 'quality_server'
  left join public.check_result m on m.capture_id = c.id and m.check_name = 'mrz'
  where c.verification_id = p_verification and c.kind in ('document_front', 'document_back')
  order by c.created_at, c.id
$$;

-- M2's flow_record_mrz, unchanged for the rider, plus: when the server has already read this photo's
-- code lines, the phone's report is compared with them now (the second of the two writes decides),
-- and the case's status reasons follow.
create or replace function public.flow_record_mrz(
  p_verification uuid,
  p_capture uuid,
  p_lines text,
  p_format text,
  p_outcome public.check_outcome,
  p_details jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  doc_key text;
  -- AES-256 rather than pgcrypto's default AES-128. A named constant also keeps the quoted option
  -- away from the key's name, which the CI secret scan (gitleaks) would read as a leaked key.
  pgp_options constant text := 'cipher-algo=aes256';
  server_check uuid;
  server_lines text;
begin
  -- The flow function validates the lines strictly and recomputes every check digit before calling;
  -- this only refuses data that is not an MRZ of the given format. The message never repeats the value.
  if p_lines is not null and not coalesce(
       (p_format = 'TD1' and p_lines ~ '^[A-Z0-9<]{30}\n[A-Z0-9<]{30}\n[A-Z0-9<]{30}$')
    or (p_format = 'TD3' and p_lines ~ '^[A-Z0-9<]{44}\n[A-Z0-9<]{44}$'), false) then
    raise exception 'flow_record_mrz: lines do not match the format' using errcode = 'invalid_parameter_value';
  end if;

  -- The case first, as every writer of a case's server checks (M3).
  perform private.worker_lock_case(p_verification);
  -- The row lock queues a retried report behind the first one, which then finds the result written.
  perform 1 from public.capture c
   where c.id = p_capture and c.verification_id = p_verification and c.deleted_at is null
   for update;
  if not found then
    return 'not_found';
  end if;

  -- 'mrz' is MRZ_CHECK_NAME in contract.ts; the dashboard looks the check up by it.
  if exists (select 1 from public.check_result cr where cr.capture_id = p_capture and cr.check_name = 'mrz') then
    return 'exists';
  end if;

  if p_lines is not null then
    select ds.decrypted_secret into doc_key from vault.decrypted_secrets ds where ds.name = 'document_data_key_v1';
    if doc_key is null then
      raise exception 'flow_record_mrz: the key document_data_key_v1 is missing from Vault';
    end if;
    insert into public.extracted_document_data (verification_id, capture_id, source, format, ciphertext, key_name)
    values (p_verification, p_capture, 'mrz_phone', p_format,
            extensions.pgp_sym_encrypt(p_lines, doc_key, pgp_options), 'document_data_key_v1');
  end if;

  insert into public.check_result (verification_id, capture_id, check_name, check_version, outcome, details)
  values (p_verification, p_capture, 'mrz', p_details ->> 'parserVersion', p_outcome, p_details);

  select cr.id into server_check from public.check_result cr
   where cr.capture_id = p_capture and cr.check_name = 'mrz_server';
  if found then
    select extensions.pgp_sym_decrypt(edd.ciphertext, ds.decrypted_secret) into server_lines
      from public.extracted_document_data edd
      join vault.decrypted_secrets ds on ds.name = edd.key_name
     where edd.capture_id = p_capture and edd.source = 'mrz_server';
    update public.check_result cr
       set details = jsonb_set(cr.details, '{phone}', to_jsonb(private.mrz_phone_agreement(p_capture, server_lines)))
     where cr.id = server_check;
    perform private.worker_refresh_policy(p_verification);
  end if;

  -- The outcome only: the lines, and anything read from them, never go into the audit log.
  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('rider', p_verification::text, 'mrz.record', 'verification', p_verification::text,
          jsonb_build_object('captureId', p_capture, 'outcome', p_outcome, 'result', p_details ->> 'result'));
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff: read the decrypted data of a case (called by the `admin` Edge Function, service role)
-- ---------------------------------------------------------------------------
-- As in M2 (audit first, same transaction, access rule checked again), for every source and only for
-- live photos: code lines in `lines` (mrz_phone, mrz_server), printed fields in `fields` (ocr_server).
drop function public.staff_read_document_data(uuid, uuid, text);
create function public.staff_read_document_data(p_verification uuid, p_actor uuid, p_role text)
returns table (capture_id uuid, source text, format text, lines text, fields jsonb, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  items public.extracted_document_data[];
begin
  if p_role is null or p_role not in ('reviewer', 'supervisor')
     or not exists (
       select 1 from public.staff_profile sp
       where sp.user_id = p_actor and sp.active and sp.role::text = p_role)
     or (p_role = 'reviewer' and not exists (
       select 1 from public.review_task rt
       where rt.verification_id = p_verification and rt.assigned_to = p_actor and rt.status = 'assigned')) then
    raise exception 'staff_read_document_data: not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- The rows are read once, and the key check, the audit count and the decryption all use that one
  -- set (see M2: reading the table again could count one set of rows and decrypt another).
  select coalesce(array_agg(edd), '{}') into items
    from public.extracted_document_data edd
    join public.capture c on c.id = edd.capture_id
   where edd.verification_id = p_verification and c.deleted_at is null;

  -- Fail loudly rather than return empty data when a row's key is gone.
  if exists (
    select 1 from unnest(items) i
    where not exists (select 1 from vault.decrypted_secrets ds where ds.name = i.key_name and ds.decrypted_secret is not null)
  ) then
    raise exception 'staff_read_document_data: a document data key is missing from Vault';
  end if;

  insert into public.audit_event (actor_type, actor_id, action, target_type, target_id, details)
  values ('staff', p_actor::text, 'document_data.view', 'verification', p_verification::text,
          jsonb_build_object('role', p_role, 'items', cardinality(items)));

  return query
    select i.capture_id, i.source, i.format,
           case when i.source = 'ocr_server' then null
                else extensions.pgp_sym_decrypt(i.ciphertext, ds.decrypted_secret) end,
           case when i.source = 'ocr_server' then extensions.pgp_sym_decrypt(i.ciphertext, ds.decrypted_secret)::jsonb
                else null end,
           i.created_at
    from unnest(items) i
    join vault.decrypted_secrets ds on ds.name = i.key_name
    order by i.created_at desc, i.id desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operations: files of replaced photos still in the bucket
-- ---------------------------------------------------------------------------
-- A replaced photo's row says it is erased; its file is removed by the flow function as it records
-- the newer photo. A file stays when that removal failed (logged), or when the photo was replaced
-- while the M2 flow still served riders: from the moment this migration is applied (its trigger marks
-- the older photo replaced) until the M3 flow is deployed (the M2 flow never removes the file). Run by
-- an administrator after the deploy (docs/M3_SPEC.md, "Deploy notes"): expected empty. What it lists is
-- removed through the Storage API (never by SQL on storage.objects), then it is run again.
create function private.superseded_files_left()
returns table (capture_id uuid, storage_path text, replaced_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select c.id, c.storage_path, c.deleted_at
  from public.capture c
  join storage.objects o on o.bucket_id = 'id-captures' and o.name = c.storage_path
  where c.superseded_by is not null
  order by c.deleted_at, c.id
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the RPCs are for the service role only; the private helpers for nobody but their owner
-- ---------------------------------------------------------------------------
revoke execute on function private.superseded_files_left() from public;
revoke execute on function private.worker_case_key(uuid) from public;
revoke execute on function private.worker_lock_case(uuid) from public;
revoke execute on function private.worker_newest_captures(uuid) from public;
revoke execute on function private.worker_case_inputs(uuid) from public;
revoke execute on function private.worker_status_reasons(uuid) from public;
revoke execute on function private.worker_refresh_policy(uuid, text[], text) from public;
revoke execute on function private.worker_apply_case(uuid, jsonb) from public;
revoke execute on function private.worker_fail_job(uuid, text) from public;
revoke execute on function private.mrz_phone_agreement(uuid, text) from public;
revoke execute on function private.capture_worker_job() from public;
revoke execute on function private.worker_sweep() from public;

revoke execute on function public.worker_use_nonce(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.worker_claim() from public, anon, authenticated;
revoke execute on function public.worker_image_lookup(uuid, integer) from public, anon, authenticated;
revoke execute on function public.worker_case_snapshot(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.worker_record_result(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.worker_write_case(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.flow_check_state(uuid) from public, anon, authenticated;
revoke execute on function public.staff_read_document_data(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.worker_use_nonce(text, text, timestamptz) to service_role;
grant execute on function public.worker_claim() to service_role;
grant execute on function public.worker_image_lookup(uuid, integer) to service_role;
grant execute on function public.worker_case_snapshot(uuid, uuid) to service_role;
grant execute on function public.worker_record_result(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text)
  to service_role;
grant execute on function public.worker_write_case(uuid, text, jsonb) to service_role;
grant execute on function public.flow_check_state(uuid) to service_role;
grant execute on function public.staff_read_document_data(uuid, uuid, text) to service_role;
