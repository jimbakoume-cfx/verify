-- Indexes for foreign keys used by RLS checks and per-case lookups (Supabase advisor 0001).
-- Other unindexed foreign keys point at tiny tables (reason codes, threshold versions) and are left as is.
create index capture_verification_idx on public.capture (verification_id);
create index consent_record_verification_idx on public.consent_record (verification_id);
create index review_task_assigned_to_idx on public.review_task (assigned_to) where assigned_to is not null;
