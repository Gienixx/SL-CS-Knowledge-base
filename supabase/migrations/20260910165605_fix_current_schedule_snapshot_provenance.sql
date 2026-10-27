-- Superseding fix for the current-schedule snapshot provenance contract.
-- A snapshot captured from public.work_schedules is website_schedule data;
-- the historical prepaid snapshot remains the immutable source record.

create or replace function public.payroll_ensure_current_schedule_snapshot(
  p_payroll_record_id uuid,
  p_schedule_id uuid,
  p_employee_id uuid,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schedule public.work_schedules%rowtype;
  v_snapshot_id uuid;
  v_approved_by uuid;
begin
  select schedule.*
  into v_schedule
  from public.work_schedules as schedule
  where schedule.id = p_schedule_id
    and schedule.user_id = p_employee_id
  for share;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Current payroll source schedule was not found.';
  end if;

  if v_schedule.status not in ('published', 'changed', 'completed') then
    raise exception using errcode = '55000',
      message = 'Current payroll source schedule is not payable.';
  end if;

  select snapshot.id
  into v_snapshot_id
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
    and snapshot.schedule_version = v_schedule.schedule_version
  order by snapshot.approved_at desc
  limit 1;

  if v_snapshot_id is not null then
    return v_snapshot_id;
  end if;

  select snapshot.approved_by
  into v_approved_by
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
  order by snapshot.schedule_version desc, snapshot.approved_at desc
  limit 1;

  v_approved_by := coalesce(v_approved_by, p_actor_user_id);

  if v_approved_by is null then
    raise exception using errcode = '42501',
      message = 'Current payroll schedule provenance needs an approving actor.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id, schedule_id, employee_id, work_date,
    shift_start, shift_end, timezone, schedule_status, is_rest_day,
    is_holiday, holiday_name, schedule_version, schedule_updated_at,
    approved_by, approved_at, approval_reason, source_type, source_reference,
    source_metadata
  )
  values (
    p_payroll_record_id, v_schedule.id, p_employee_id, v_schedule.shift_date,
    v_schedule.shift_start, v_schedule.shift_end, v_schedule.timezone,
    v_schedule.status, v_schedule.is_rest_day, v_schedule.is_holiday,
    v_schedule.holiday_name, v_schedule.schedule_version, v_schedule.updated_at,
    v_approved_by, pg_catalog.now(),
    'Current authoritative schedule captured during payroll recalculation',
    'website_schedule', null,
    jsonb_build_object(
      'source', 'current_work_schedule',
      'previous_snapshot_preserved', true
    )
  )
  on conflict (payroll_record_id, schedule_id, schedule_version) do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    select snapshot.id
    into v_snapshot_id
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.payroll_record_id = p_payroll_record_id
      and snapshot.employee_id = p_employee_id
      and snapshot.schedule_id = v_schedule.id
      and snapshot.schedule_version = v_schedule.schedule_version
    order by snapshot.approved_at desc
    limit 1;
  end if;

  return v_snapshot_id;
end;
$function$;

revoke all on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  to service_role;

;
