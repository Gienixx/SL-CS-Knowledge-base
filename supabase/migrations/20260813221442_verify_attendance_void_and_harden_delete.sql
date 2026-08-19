create or replace function public.workforce_delete_attendance(p_attendance_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_actor_user_id uuid := auth.uid(); v_attendance public.attendance%rowtype; v_reason text := trim(coalesce(p_reason, ''));
begin
  if v_actor_user_id is null or not public.workforce_current_user_is_active() then raise exception 'Authenticated active workforce session is required.'; end if;
  if not public.workforce_is_admin() or not (public.workforce_has_permission('manage_schedules') or public.workforce_has_permission('correct_attendance')) then raise exception 'You do not have permission to delete attendance records.'; end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if length(v_reason) < 3 then raise exception 'A deletion reason of at least 3 characters is required.'; end if;
  select attendance_row.* into v_attendance from public.attendance attendance_row where attendance_row.id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_attendance.voided_at is not null then raise exception 'This attendance record has already been deleted.'; end if;
  if v_attendance.review_status = 'locked' then raise exception 'This attendance record cannot be deleted because it is already finalized.'; end if;
  if not public.workforce_can_manage_user(v_attendance.user_id, 'correct_attendance') and not public.workforce_can_manage_user(v_attendance.user_id, 'manage_schedules') then raise exception 'You do not have permission to manage this employee.'; end if;
  if exists (select 1 from public.payroll_attendance_snapshots snapshot join public.payroll_records record on record.id = snapshot.payroll_record_id where snapshot.attendance_id = v_attendance.id and record.status = 'finalized') then raise exception 'This attendance record cannot be deleted because it is already included in finalized payroll.'; end if;
  insert into public.workforce_audit_logs (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (v_actor_user_id, 'attendance_deleted', 'attendance', v_attendance.id, to_jsonb(v_attendance), jsonb_build_object('target_employee_id', v_attendance.user_id, 'voided', true), v_reason);
  update public.attendance set voided_at = statement_timestamp(), voided_by = v_actor_user_id, void_reason = v_reason, updated_at = statement_timestamp() where id = v_attendance.id and voided_at is null;
  if not found then raise exception 'Attendance record was not deleted. Please try again or contact admin.'; end if;
  perform public.workforce_recalculate_attendance_work_date(v_attendance.user_id, v_attendance.work_date);
  return v_attendance.id;
end;
$$;
create or replace function public.workforce_verify_attendance_void(p_attendance_id uuid)
returns table (attendance_id uuid, voided_at timestamptz, voided_by uuid, void_reason text, review_status text)
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not public.workforce_is_admin() or not public.workforce_has_permission('view_team_attendance') then raise exception 'Administrator access is required.'; end if;
  return query select a.id, a.voided_at, a.voided_by, a.void_reason, a.review_status from public.attendance a where a.id = p_attendance_id;
end;
$$;
revoke all on function public.workforce_delete_attendance(uuid, text) from public, anon, authenticated;
grant execute on function public.workforce_delete_attendance(uuid, text) to authenticated, service_role;
revoke all on function public.workforce_verify_attendance_void(uuid) from public, anon, authenticated;
grant execute on function public.workforce_verify_attendance_void(uuid) to authenticated, service_role;
