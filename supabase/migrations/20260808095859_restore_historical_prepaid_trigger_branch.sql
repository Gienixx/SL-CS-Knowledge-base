-- Controlled historical prepaid restoration for already-approved attendance.
-- Normal future prepaid entry rules remain enforced by
-- payroll_save_and_approve_prepaid_schedule.

begin;

create or replace function public.payroll_create_prepaid_balance()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_previous_balance record;
  v_new_prepaid_hour_id uuid;
  v_restore_minutes integer;
begin
  if coalesce(new.source_metadata ->> 'historical_restore', 'false') = 'true' then
    v_restore_minutes := (new.source_metadata ->> 'restored_prepaid_minutes')::integer;
    if v_restore_minutes is null or v_restore_minutes <= 0 then
      raise exception using errcode = '22023', message = 'Historical prepaid restoration requires positive restored minutes.';
    end if;
    insert into public.payroll_prepaid_hours (source_payroll_record_id, source_schedule_snapshot_id, employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at)
    values (new.payroll_record_id, new.id, new.employee_id, v_restore_minutes, 0, new.approved_by, new.approved_at, new.approved_at)
    on conflict (source_schedule_snapshot_id) do nothing
    returning id into v_new_prepaid_hour_id;
    return new;
  end if;
  if new.is_rest_day or new.is_holiday or new.scheduled_minutes <= 0 then
    raise exception using errcode = '22023', message = 'Only future ordinary schedules with positive minutes can create prepaid-hour balances.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.payroll_prepaid_hours:' || new.employee_id::text, 0));
  for v_previous_balance in
    select prepaid.id, prepaid.settled_minutes
    from public.payroll_prepaid_hours prepaid
    join public.payroll_schedule_snapshots previous_snapshot on previous_snapshot.id = prepaid.source_schedule_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.schedule_id = new.schedule_id and previous_snapshot.id <> new.id
      and prepaid.voided_at is null
    order by previous_snapshot.schedule_version, prepaid.id for update of prepaid
  loop
    if v_previous_balance.settled_minutes > 0 then
      raise exception using errcode = '55000', message = 'A changed pre-plot cannot be reapproved after its prepaid balance has started settling.';
    end if;
  end loop;
  insert into public.payroll_prepaid_hours (source_payroll_record_id, source_schedule_snapshot_id, employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at)
  values (new.payroll_record_id, new.id, new.employee_id, new.scheduled_minutes, 0, new.approved_by, new.approved_at, new.approved_at)
  on conflict (source_schedule_snapshot_id) do nothing
  returning id into v_new_prepaid_hour_id;
  if v_new_prepaid_hour_id is null then
    select prepaid.id into v_new_prepaid_hour_id from public.payroll_prepaid_hours prepaid where prepaid.source_schedule_snapshot_id = new.id;
  end if;
  update public.payroll_prepaid_hours prepaid
  set voided_at = new.approved_at, voided_by = new.approved_by,
      void_reason = 'Superseded by approved schedule version ' || new.schedule_version::text || '.',
      superseded_by_id = v_new_prepaid_hour_id
  from public.payroll_schedule_snapshots previous_snapshot
  where previous_snapshot.id = prepaid.source_schedule_snapshot_id
    and previous_snapshot.payroll_record_id = new.payroll_record_id
    and previous_snapshot.schedule_id = new.schedule_id and previous_snapshot.id <> new.id
    and prepaid.voided_at is null;
  return new;
end;
$$;

create or replace function public.payroll_restore_historical_prepaid_attendance(
  p_payroll_record_id uuid,
  p_attendance_id uuid,
  p_prepaid_minutes integer,
  p_source_evidence text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_snapshot_id uuid;
  v_prepaid_id uuid;
  v_reason text := nullif(trim(p_source_evidence), '');
begin
  if auth.uid() is null or v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501', message = 'You do not have permission to restore historical prepaid hours.';
  end if;

  if p_payroll_record_id is null or p_attendance_id is null
     or p_prepaid_minutes is null or p_prepaid_minutes <= 0
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'Payroll record, attendance, positive minutes, and source evidence are required.';
  end if;

  select * into v_record from public.payroll_records where id = p_payroll_record_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll record was not found.'; end if;
  select * into v_period from public.payroll_periods where id = v_record.payroll_period_id for update;
  if v_period.status not in ('draft','reopened') or v_record.status in ('finalized','approved','void') then
    raise exception using errcode = '55000', message = 'Historical prepaid restoration is allowed only for Draft or Reopened payroll.';
  end if;

  select * into v_attendance from public.attendance
  where id = p_attendance_id and user_id = v_record.employee_id and review_status = 'approved' for update;
  if not found then raise exception using errcode = '55000', message = 'Approved attendance for this payroll employee was not found.'; end if;
  -- Historical restoration follows the period cutoff, including payout-date
  -- evidence already present in the historical payroll record.
  if v_attendance.work_date < v_period.period_start or v_attendance.work_date > v_period.period_end then
    raise exception using errcode = '22023', message = 'Attendance date is outside the payroll cutoff.';
  end if;

  select * into v_schedule from public.work_schedules where id = v_attendance.schedule_id for update;
  if not found then raise exception using errcode = '55000', message = 'The attendance source schedule was not found.'; end if;

  if exists (
    select 1 from public.payroll_prepaid_hours p
    join public.payroll_schedule_snapshots s on s.id = p.source_schedule_snapshot_id
    where p.source_payroll_record_id = v_record.id and p.employee_id = v_record.employee_id
      and s.work_date = v_attendance.work_date and p.voided_at is null
  ) then
    raise exception using errcode = '23505', message = 'An active historical prepaid source already exists for this employee and date.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id, schedule_id, employee_id, work_date, shift_start, shift_end,
    timezone, schedule_status, is_rest_day, is_holiday, holiday_name,
    schedule_version, schedule_updated_at, approved_by, approved_at,
    approval_reason, source_type, source_reference, source_metadata
  ) values (
    v_record.id, v_schedule.id, v_record.employee_id, v_attendance.work_date,
    v_schedule.shift_start, v_schedule.shift_end, v_schedule.timezone,
    v_schedule.status, v_schedule.is_rest_day, v_schedule.is_holiday,
    v_schedule.holiday_name, v_schedule.schedule_version, v_schedule.updated_at,
    v_actor, statement_timestamp(), v_reason, 'excel_import', v_reason,
    jsonb_build_object('attendance_id', v_attendance.id, 'evidence', v_reason,
      'historical_restore', true, 'restored_prepaid_minutes', p_prepaid_minutes)
  ) returning id into v_snapshot_id;

  insert into public.payroll_prepaid_hours (
    source_payroll_record_id, source_schedule_snapshot_id, employee_id,
    prepaid_minutes, settled_minutes, created_by
  ) values (v_record.id, v_snapshot_id, v_record.employee_id, p_prepaid_minutes, 0, v_actor)
  returning id into v_prepaid_id;

  insert into public.payroll_audit_logs (
    actor_user_id, action, entity_type, entity_id, payroll_period_id,
    payroll_record_id, after_data, reason, metadata
  ) values (
    v_actor, 'payroll_historical_prepaid_restored', 'payroll_prepaid_hours',
    v_prepaid_id, v_period.id, v_record.id,
    jsonb_build_object('prepaid_hour_id', v_prepaid_id, 'schedule_snapshot_id', v_snapshot_id,
      'attendance_id', v_attendance.id, 'work_date', v_attendance.work_date,
      'prepaid_minutes', p_prepaid_minutes), v_reason,
    jsonb_build_object('source_type', 'historical_restore', 'rest_day_allowed', true)
  );

  return jsonb_build_object('payroll_record_id', v_record.id, 'attendance_id', v_attendance.id,
    'prepaid_hour_id', v_prepaid_id, 'schedule_snapshot_id', v_snapshot_id,
    'prepaid_minutes', p_prepaid_minutes);
end;
$$;

revoke all on function public.payroll_restore_historical_prepaid_attendance(uuid, uuid, integer, text) from public, anon;
grant execute on function public.payroll_restore_historical_prepaid_attendance(uuid, uuid, integer, text) to authenticated, service_role;

commit;
