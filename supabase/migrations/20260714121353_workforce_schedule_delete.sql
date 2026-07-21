begin;

create or replace function public.workforce_admin_delete_schedule(
  p_schedule_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule public.work_schedules%rowtype;
  v_attendance_count integer;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_schedules') then
    raise exception 'Administrator schedule-management access is required.'
      using errcode = '42501';
  end if;

  if p_schedule_id is null then
    raise exception 'Schedule ID is required.';
  end if;

  select *
  into v_schedule
  from public.work_schedules
  where id = p_schedule_id
  for update;

  if not found then
    raise exception 'Schedule entry not found.';
  end if;

  if not public.workforce_can_manage_user(v_schedule.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to delete this employee schedule.'
      using errcode = '42501';
  end if;

  select count(*)::integer
  into v_attendance_count
  from public.attendance
  where schedule_id = p_schedule_id;

  delete from public.work_schedules
  where id = p_schedule_id;

  return jsonb_build_object(
    'deleted_schedule_id', v_schedule.id,
    'employee_user_id', v_schedule.user_id,
    'shift_date', v_schedule.shift_date,
    'detached_attendance_records', v_attendance_count
  );
end;
$$;

revoke all on function public.workforce_admin_delete_schedule(uuid) from public;
revoke all on function public.workforce_admin_delete_schedule(uuid) from anon;
grant execute on function public.workforce_admin_delete_schedule(uuid) to authenticated;

comment on function public.workforce_admin_delete_schedule(uuid) is
  'Deletes one authorized workforce schedule and leaves linked attendance intact with a null schedule reference.';

commit;
