alter table public.attendance
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references public.profiles(user_id) on delete restrict,
  add column if not exists void_reason text;

create index if not exists attendance_not_voided_work_date_idx
  on public.attendance (work_date, user_id)
  where voided_at is null;

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
  if v_actor_user_id is null or not public.workforce_current_user_is_active() then
    raise exception 'Authenticated active workforce session is required.';
  end if;

  if not public.workforce_is_admin()
     or not (public.workforce_has_permission('manage_schedules')
       or public.workforce_has_permission('correct_attendance')) then
    raise exception 'You do not have permission to delete attendance records.';
  end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if length(v_reason) < 3 then raise exception 'A deletion reason of at least 3 characters is required.'; end if;

  select attendance_row.* into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_attendance.voided_at is not null then raise exception 'This attendance record has already been deleted.'; end if;
  if v_attendance.review_status = 'locked' then
    raise exception 'This attendance record cannot be deleted because it is already finalized.';
  end if;
  if not public.workforce_can_manage_user(v_attendance.user_id, 'correct_attendance')
     and not public.workforce_can_manage_user(v_attendance.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee.';
  end if;
  if exists (
    select 1 from public.payroll_attendance_snapshots snapshot
    join public.payroll_records record on record.id = snapshot.payroll_record_id
    where snapshot.attendance_id = v_attendance.id and record.status = 'finalized'
  ) then
    raise exception 'This attendance record cannot be deleted because it is already included in finalized payroll.';
  end if;

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values
    (v_actor_user_id, 'attendance_deleted', 'attendance', v_attendance.id,
     to_jsonb(v_attendance), jsonb_build_object('target_employee_id', v_attendance.user_id, 'voided', true), v_reason);

  update public.attendance
  set voided_at = statement_timestamp(), voided_by = v_actor_user_id, void_reason = v_reason,
      review_status = 'voided', updated_at = statement_timestamp()
  where id = v_attendance.id;

  perform public.workforce_recalculate_attendance_work_date(v_attendance.user_id, v_attendance.work_date);
  return v_attendance.id;
end;
$$;

revoke all on function public.workforce_delete_attendance(uuid, text) from public, anon, authenticated;
grant execute on function public.workforce_delete_attendance(uuid, text) to authenticated, service_role;

comment on function public.workforce_delete_attendance(uuid, text) is
  'Audited soft-void for eligible attendance; preserves the row and blocks finalized payroll changes.';
