-- Phase 1, Step 2: make payroll-sensitive attendance changes reachable only
-- through authenticated, scoped, audited RPCs.

-- Browser roles may read attendance through RLS, but may not write the table
-- directly. Clocking, manual creation, correction, review, and deletion are
-- all handled by dedicated SECURITY DEFINER functions with identity checks.
drop policy if exists "Authorized users can insert attendance" on public.attendance;
drop policy if exists "Authorized users can update attendance" on public.attendance;
drop policy if exists "Authorized users can delete attendance" on public.attendance;

revoke all on table public.attendance from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.attendance from authenticated;
grant select on table public.attendance to authenticated;

-- Correction history is append-only. Authenticated administrators retain the
-- existing scoped read policy, while only the correction RPC (running as its
-- owner) can append history. No browser role can alter or remove prior rows.
drop policy if exists "Admins can insert attendance correction history"
  on public.attendance_corrections;
drop policy if exists "Admins can update attendance correction history"
  on public.attendance_corrections;
drop policy if exists "Admins can delete attendance correction history"
  on public.attendance_corrections;
drop policy if exists "Admins can view attendance correction history"
  on public.attendance_corrections;

create policy "Admins can view attendance correction history"
  on public.attendance_corrections
  for select
  to authenticated
  using (
    (select public.workforce_current_user_is_active())
    and (select public.workforce_is_admin())
  );

revoke all on table public.attendance_corrections from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.attendance_corrections from authenticated;
grant select on table public.attendance_corrections to authenticated;

-- Deleting a parent attendance row must never erase its correction history.
alter table public.attendance_corrections
  drop constraint if exists attendance_corrections_attendance_id_fkey;

alter table public.attendance_corrections
  add constraint attendance_corrections_attendance_id_fkey
  foreign key (attendance_id)
  references public.attendance(id)
  on delete restrict;

create or replace function public.workforce_delete_attendance(
  p_attendance_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_attendance public.attendance%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_schedules') then
    raise exception 'You do not have permission to delete attendance records.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if length(v_reason) < 3 then
    raise exception 'A deletion reason of at least 3 characters is required.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if v_attendance.review_status = 'locked' then
    raise exception 'Locked attendance cannot be changed or deleted.';
  end if;

  if not public.workforce_can_manage_user(v_attendance.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee.';
  end if;

  if exists (
    select 1
    from public.attendance_corrections correction
    where correction.attendance_id = v_attendance.id
  ) then
    raise exception 'Attendance with correction history cannot be deleted.';
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    reason
  ) values (
    v_actor_user_id,
    'attendance_deleted',
    'attendance',
    v_attendance.id,
    to_jsonb(v_attendance),
    v_reason
  );

  delete from public.attendance
  where id = v_attendance.id;

  return v_attendance.id;
end;
$$;

comment on function public.workforce_delete_attendance(uuid, text) is
  'Deletes an unlocked attendance row without correction history after admin, permission, scope, reason, and audit checks.';

revoke all on function public.workforce_delete_attendance(uuid, text)
  from public, anon, authenticated;
grant execute on function public.workforce_delete_attendance(uuid, text)
  to authenticated, service_role;

-- Cancellation already authenticates internally; anonymous execution adds no
-- capability and unnecessarily exposes a SECURITY DEFINER API endpoint.
revoke all on function public.workforce_cancel_leave_request(uuid)
  from public, anon;
grant execute on function public.workforce_cancel_leave_request(uuid)
  to authenticated, service_role;
