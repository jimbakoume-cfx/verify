-- Move the SECURITY DEFINER role helpers out of the API-exposed `public` schema so they
-- cannot be called as /rest/v1/rpc/... endpoints (Supabase advisor 0029).
-- RLS policies reference functions by identity, so they keep working after the move.
create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

alter function public.current_staff_role() set schema private;
alter function public.is_staff_at_least(public.staff_role) set schema private;
alter function public.is_assigned_reviewer(uuid) set schema private;

-- Its body named public.current_staff_role(); point it at the new location.
create or replace function private.is_staff_at_least(minimum public.staff_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_staff_role() >= minimum, false)
$$;
