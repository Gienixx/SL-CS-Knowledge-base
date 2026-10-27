begin;

-- One-purpose reconciliation for the known Arby Sep 14 legacy prepaid row.
-- This deliberately does not alter the existing prepaid/schedule RPCs.
create function public.payroll_reconcile_arby_sep14_legacy_rest_day_prepaid(
  p_actor_user_id uuid,
  p_reason text default 'Reconcile Sep 14 prepaid entry created as an ordinary schedule before weekly generation; authoritative recurring template classifies the date as Rest Day.'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_employee constant uuid := 'f69a9e68-5507-4132-af60-e7cc1255d8c2';
  c_prepaid constant uuid := '70c02fd0-154d-4f29-83d1-82eff786714b';
  c_schedule constant uuid := '336701bf-e8d7-4a97-a697-3b9656b984b0';
  c_legacy_snapshot constant uuid := 'f8b0d6ec-1d27-49e1-b6fc-5a410a67de14';
  c_record constant uuid := '14765c5a-2f96-4a72-b600-f2e78b467f5e';
  c_period constant uuid := '2030808c-8292-4cd2-b994-2b1afbed371e';
  c_assignment constant uuid := '96419998-17a8-4ab9-b86a-62f60ebbfec6';
  c_template constant uuid := '742d3c50-880b-4d0e-833e-58321e57f9cf';
  c_work_date constant date := date '2026-09-14';
  c_reconciliation_note constant text := 'Reconciled to authoritative recurring Rest Day after legacy prepaid schedule-classification bug.';
  v_old public.payroll_prepaid_hours%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_snapshot public.payroll_schedule_snapshots%rowtype;
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_assignment public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_template_day public.work_schedule_template_days%rowtype;
  v_schedule_after public.work_schedules%rowtype;
  v_new_snapshot_id uuid;
  v_new_prepaid_id uuid;
  v_schedule_count bigint;
  v_snapshot_count bigint;
  v_prepaid_count bigint;
  v_allocation_count bigint;
  v_attendance_count bigint;
  v_item_count bigint;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501',
      message = 'This reconciliation is service-role only.';
  end if;

  if p_actor_user_id is null
     or not exists (
       select 1 from public.profiles actor
       where actor.user_id = p_actor_user_id
         and actor.is_system_admin is true
         and actor.account_deleted_at is null
     ) then
    raise exception using errcode = '42501',
      message = 'A non-deleted system administrator actor is required.';
  end if;

  if v_reason is null then
    raise exception using errcode = '22023',
      message = 'A reconciliation reason is required.';
  end if;

  -- Serialize against the existing prepaid creation/reconciliation paths and
  -- against a second invocation of this exact repair.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_prepaid_hours:' || c_employee::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_reconcile_arby_sep14:' || c_employee::text, 0)
  );

  select prepaid.* into v_old
  from public.payroll_prepaid_hours prepaid
  where prepaid.id = c_prepaid
  for update;

  if not found then
    raise exception using errcode = '55000',
      message = 'The exact legacy prepaid entry is missing.';
  end if;

  if v_old.source_payroll_record_id is distinct from c_record
     or v_old.source_schedule_snapshot_id is distinct from c_legacy_snapshot
     or v_old.employee_id is distinct from c_employee
     or v_old.prepaid_minutes is distinct from 720
     or v_old.settled_minutes is distinct from 0
     or v_old.remaining_minutes is distinct from 720
     or v_old.status is distinct from 'open'
     or v_old.prepaid_version is distinct from 1
     or v_old.prepaid_day_type is distinct from 'ordinary'
     or v_old.voided_at is not null
     or v_old.superseded_by_id is not null
     or v_old.correction_of_id is not null then
    raise exception using errcode = '40001',
      message = 'The exact legacy prepaid state has drifted or was already reconciled.';
  end if;

  select schedule.* into v_schedule
  from public.work_schedules schedule
  where schedule.id = c_schedule
  for update;

  if not found
     or v_schedule.user_id is distinct from c_employee
     or v_schedule.shift_date is distinct from c_work_date
     or v_schedule.shift_start is distinct from timestamptz '2026-09-14 04:00:00+00'
     or v_schedule.shift_end is distinct from timestamptz '2026-09-14 16:00:00+00'
     or v_schedule.timezone is distinct from 'America/New_York'
     or v_schedule.status <> 'published'
     or v_schedule.is_rest_day
     or v_schedule.is_holiday
     or v_schedule.schedule_template_id is not null
     or v_schedule.generated_by_automation
     or v_schedule.admin_override
     or v_schedule.schedule_version is distinct from 1
     or v_schedule.is_leave
     or v_schedule.is_absent
     or v_schedule.leave_type is not null
     or v_schedule.absence_type is not null
     or v_schedule.leave_request_id is not null then
    raise exception using errcode = '40001',
      message = 'The exact legacy schedule state has drifted.';
  end if;

  select count(*) into v_schedule_count
  from public.work_schedules schedule
  where schedule.user_id = c_employee and schedule.shift_date = c_work_date;
  if v_schedule_count <> 1 then
    raise exception using errcode = '55000',
      message = 'A competing Sep 14 schedule exists.';
  end if;

  select snapshot.* into v_snapshot
  from public.payroll_schedule_snapshots snapshot
  where snapshot.id = c_legacy_snapshot
  for update;

  if not found
     or v_snapshot.payroll_record_id is distinct from c_record
     or v_snapshot.schedule_id is distinct from c_schedule
     or v_snapshot.employee_id is distinct from c_employee
     or v_snapshot.work_date is distinct from c_work_date
     or v_snapshot.shift_start is distinct from timestamptz '2026-09-14 04:00:00+00'
     or v_snapshot.shift_end is distinct from timestamptz '2026-09-14 16:00:00+00'
     or v_snapshot.timezone is distinct from 'America/New_York'
     or v_snapshot.schedule_status <> 'published'
     or v_snapshot.is_rest_day
     or v_snapshot.is_holiday
     or v_snapshot.schedule_version is distinct from 1
     or v_snapshot.prepaid_minutes is not null then
    raise exception using errcode = '40001',
      message = 'The exact legacy snapshot state has drifted.';
  end if;

  select count(*) into v_snapshot_count
  from public.payroll_schedule_snapshots candidate
  where candidate.payroll_record_id = c_record
    and candidate.schedule_id = c_schedule;
  if v_snapshot_count <> 1 then
    raise exception using errcode = '55000',
      message = 'A later schedule snapshot already exists for the legacy schedule.';
  end if;

  select record.* into v_record
  from public.payroll_records record
  where record.id = c_record
    and record.employee_id = c_employee
  for update;
  if not found
     or v_record.payroll_period_id is distinct from c_period
     or v_record.status <> 'draft'
     or v_record.calculated_at is not null
     or v_record.calculated_by is not null
     or v_record.finalized_at is not null
     or v_record.gross_pay is distinct from 0
     or v_record.net_pay is distinct from 0 then
    raise exception using errcode = '55000',
      message = 'The payroll record is not the expected draft and uncalculated record.';
  end if;

  select period.* into v_period
  from public.payroll_periods period
  where period.id = c_period
  for update;
  if not found
     or v_period.status <> 'draft'
     or v_period.finalization_version is distinct from 0
     or v_period.finalized_at is not null then
    raise exception using errcode = '55000',
      message = 'The payroll period is not the expected editable draft.';
  end if;

  select count(*) into v_item_count
  from public.payroll_items item
  where item.payroll_record_id = c_record;
  if v_item_count <> 0 then
    raise exception using errcode = '55000',
      message = 'Payroll items block this reconciliation.';
  end if;

  select count(*) into v_attendance_count
  from public.attendance attendance_row
  where attendance_row.user_id = c_employee
    and attendance_row.work_date = c_work_date;
  if v_attendance_count <> 0 then
    raise exception using errcode = '55000',
      message = 'Attendance blocks this reconciliation.';
  end if;

  select count(*) into v_allocation_count
  from public.payroll_hour_allocations allocation
  where allocation.prepaid_hour_id = c_prepaid;
  if v_allocation_count <> 0 then
    raise exception using errcode = '55000',
      message = 'Settlement allocations block this reconciliation.';
  end if;

  select count(*) into v_prepaid_count
  from public.payroll_prepaid_hours other
  join public.payroll_schedule_snapshots other_snapshot
    on other_snapshot.id = other.source_schedule_snapshot_id
  where other.employee_id = c_employee
    and other.id <> c_prepaid
    and other_snapshot.payroll_record_id = c_record
    and other_snapshot.schedule_id = c_schedule;
  if v_prepaid_count <> 0 then
    raise exception using errcode = '55000',
      message = 'A later prepaid version already exists for the legacy schedule.';
  end if;

  select assignment.* into v_assignment
  from public.work_schedule_template_assignments assignment
  where assignment.id = c_assignment
    and assignment.user_id = c_employee
    and assignment.template_id = c_template
    and assignment.is_active
    and assignment.effective_from <= c_work_date
    and (assignment.effective_until is null or assignment.effective_until >= c_work_date)
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'The expected active recurring assignment is missing or changed.';
  end if;

  select template.* into v_template
  from public.work_schedule_templates template
  where template.id = c_template
    and template.is_active
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'The expected active recurring template is missing or changed.';
  end if;

  select day_row.* into v_template_day
  from public.work_schedule_template_days day_row
  where day_row.template_id = c_template
    and day_row.weekday = 1
  for update;
  if not found
     or v_template_day.is_rest_day is distinct from true
     or v_template_day.start_time is not null
     or v_template_day.end_time is not null
     or exists (
       select 1 from public.work_schedule_template_days another_day
       where another_day.template_id = c_template
         and another_day.weekday = 1
         and another_day.id <> v_template_day.id
     ) then
    raise exception using errcode = '55000',
      message = 'The expected Monday untimed Rest Day source has changed.';
  end if;

  update public.work_schedules
  set shift_start = null,
      shift_end = null,
      is_rest_day = true,
      is_holiday = false,
      holiday_name = null,
      schedule_template_id = c_template,
      generated_by_automation = true,
      admin_override = false,
      notes = case
        when coalesce(trim(notes), '') = '' then c_reconciliation_note
        else notes || E'\n' || c_reconciliation_note
      end,
      updated_by = p_actor_user_id
  where id = c_schedule
  returning * into v_schedule_after;

  if v_schedule_after.schedule_version is distinct from 2
     or not v_schedule_after.is_rest_day
     or v_schedule_after.shift_start is not null
     or v_schedule_after.shift_end is not null
     or v_schedule_after.schedule_template_id is distinct from c_template
     or not v_schedule_after.generated_by_automation
     or v_schedule_after.admin_override then
    raise exception using errcode = '55000',
      message = 'The normal schedule-version mechanism produced an unexpected result.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id, schedule_id, employee_id, work_date,
    shift_start, shift_end, timezone, schedule_status, is_rest_day,
    is_holiday, holiday_name, schedule_version, schedule_updated_at,
    approved_by, approved_at, approval_reason, source_type, source_reference,
    source_metadata, prepaid_minutes
  ) values (
    c_record, c_schedule, c_employee, c_work_date,
    null, null, v_schedule_after.timezone, v_schedule_after.status, true,
    false, null, v_schedule_after.schedule_version, v_schedule_after.updated_at,
    p_actor_user_id, statement_timestamp(), v_reason, 'website_schedule',
    'legacy_prepaid_rest_day_reconciliation:' || c_prepaid::text,
    jsonb_build_object(
      'entry_mode', 'legacy_prepaid_rest_day_reconciliation',
      'prepaid_day_type', 'rest_day',
      'prepaid_login', '00:00:00',
      'prepaid_logout', '12:00:00',
      'prepaid_timezone', 'America/New_York',
      'legacy_prepaid_hour_id', c_prepaid,
      'legacy_snapshot_id', c_legacy_snapshot,
      'legacy_schedule_id', c_schedule,
      'reconciliation_reason', v_reason
    ),
    720
  ) returning id into v_new_snapshot_id;

  select prepaid.id into v_new_prepaid_id
  from public.payroll_prepaid_hours prepaid
  where prepaid.source_schedule_snapshot_id = v_new_snapshot_id;

  if v_new_prepaid_id is null then
    raise exception using errcode = '55000',
      message = 'The Rest Day snapshot did not create a prepaid balance.';
  end if;

  if not exists (
    select 1 from public.payroll_prepaid_hours prepaid
    where prepaid.id = v_new_prepaid_id
      and prepaid.source_payroll_record_id = c_record
      and prepaid.employee_id = c_employee
      and prepaid.prepaid_minutes = 720
      and prepaid.settled_minutes = 0
      and prepaid.remaining_minutes = 720
      and prepaid.status = 'open'
      and prepaid.prepaid_day_type = 'rest_day'
      and prepaid.voided_at is null
      and prepaid.superseded_by_id is null
  ) then
    raise exception using errcode = '55000',
      message = 'The new Rest Day prepaid balance failed its exact postcondition.';
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id, action, entity_type, entity_id, payroll_period_id,
    payroll_record_id, before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id,
    -- This existing audit action is part of the payroll exception read model's
    -- approved-preplot allowlist; metadata below distinguishes this guarded
    -- legacy reconciliation from an ordinary UI approval.
    'payroll_rest_day_preplot_approved',
    'payroll_schedule_snapshot',
    v_new_snapshot_id,
    c_period,
    c_record,
    jsonb_build_object(
      'employee_id', c_employee,
      'work_date', c_work_date,
      'schedule_id', c_schedule,
      'schedule_version', 1,
      'snapshot_id', c_legacy_snapshot,
      'prepaid_hour_id', c_prepaid,
      'prepaid_day_type', 'ordinary',
      'prepaid_minutes', 720,
      'settled_minutes', 0,
      'historical_snapshot_preserved', true
    ),
    jsonb_build_object(
      'employee_id', c_employee,
      'work_date', c_work_date,
      'schedule_id', c_schedule,
      'schedule_version', v_schedule_after.schedule_version,
      'snapshot_id', v_new_snapshot_id,
      'prepaid_hour_id', v_new_prepaid_id,
      'prepaid_day_type', 'rest_day',
      'prepaid_minutes', 720,
      'settled_minutes', 0,
      'remaining_minutes', 720,
      'recurring_assignment_id', c_assignment,
      'recurring_template_id', c_template,
      'no_settlement_existed', true,
      'no_attendance_existed', true,
      'historical_snapshot_preserved', true
    ),
    v_reason,
    jsonb_build_object(
      'legacy_schedule_id', c_schedule,
      'legacy_snapshot_id', c_legacy_snapshot,
      'legacy_prepaid_hour_id', c_prepaid,
      'new_snapshot_id', v_new_snapshot_id,
      'new_prepaid_hour_id', v_new_prepaid_id,
      'schedule_version_before', 1,
      'schedule_version_after', v_schedule_after.schedule_version,
      'recurring_assignment_id', c_assignment,
      'recurring_template_id', c_template,
      'actor_user_id', p_actor_user_id,
      'repair_type', 'single_target_legacy_prepaid_rest_day_reconciliation'
    )
  );

  return jsonb_build_object(
    'status', 'reconciled',
    'employee_id', c_employee,
    'work_date', c_work_date,
    'schedule_id', c_schedule,
    'schedule_version_before', 1,
    'schedule_version_after', v_schedule_after.schedule_version,
    'legacy_snapshot_id', c_legacy_snapshot,
    'new_snapshot_id', v_new_snapshot_id,
    'superseded_prepaid_hour_id', c_prepaid,
    'new_prepaid_hour_id', v_new_prepaid_id,
    'prepaid_day_type', 'rest_day',
    'prepaid_minutes', 720,
    'settled_minutes', 0,
    'remaining_minutes', 720,
    'payroll_items_created', 0,
    'attendance_created', 0,
    'allocations_created', 0
  );
end;
$$;

revoke all on function public.payroll_reconcile_arby_sep14_legacy_rest_day_prepaid(uuid, text)
  from public, anon, authenticated;
grant execute on function public.payroll_reconcile_arby_sep14_legacy_rest_day_prepaid(uuid, text)
  to service_role;

comment on function public.payroll_reconcile_arby_sep14_legacy_rest_day_prepaid(uuid, text) is
  'Single-purpose service-role reconciliation for the exact Arby Sep 14 legacy ordinary prepaid entry. Preserves the original snapshot, creates a Rest Day snapshot, and relies on the existing prepaid supersession trigger.';

commit;

;
