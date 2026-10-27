-- Share the deployed preview formula with the first-time V2 calculation
-- writer. The calculation snapshot and every child row are written in one
-- guarded RPC call; the legacy Payroll V1 tables are never written.

alter table public.payroll_v2_records
  add column calculation_snapshot jsonb not null default '{}'::jsonb;

alter table public.payroll_v2_records
  add constraint payroll_v2_records_calculation_snapshot_object_check
  check (jsonb_typeof(calculation_snapshot) = 'object');

alter function public.payroll_v2_preview_employee(uuid, uuid)
  rename to payroll_v2_employee_calculation_payload;

revoke all on function public.payroll_v2_employee_calculation_payload(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.payroll_v2_preview_employee(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select public.payroll_v2_employee_calculation_payload(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
$function$;

revoke all on function public.payroll_v2_preview_employee(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_preview_employee(uuid, uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_preview_employee(uuid, uuid) is
  'Read-only Payroll V2 employee preview; delegates to the same authoritative calculation payload used by Calculate Employee.';

create or replace function public.payroll_v2_calculate_employee(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_calculation jsonb;
  v_snapshot jsonb;
  v_read_model jsonb;
  v_record_id uuid;
  v_item jsonb;
  v_day jsonb;
  v_target jsonb;
  v_source_id uuid;
  v_rows jsonb;
  v_row jsonb;
  v_source_attendance_ids uuid[];
  v_source_schedule_ids uuid[];
  v_source_version text := 'payroll_v2_get_individual_payslip_data/current';
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to calculate Payroll Dashboard V2 employee pay.';
  end if;

  if p_payroll_v2_period_id is null or p_employee_user_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period and employee are required.';
  end if;

  -- Serializing calculations on the parent period makes concurrent requests
  -- deterministic. The unique active-record index remains the final guard.
  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id
  for update;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;
  if v_period.status = 'void' then
    raise exception using errcode = '55000',
      message = 'A Void Payroll V2 period cannot be calculated.';
  end if;

  if exists (
    select 1 from public.payroll_v2_records record
    where record.payroll_v2_period_id = p_payroll_v2_period_id
      and record.employee_user_id = p_employee_user_id
      and record.status <> 'void'
  ) then
    raise exception using errcode = '23505',
      message = 'Payroll already calculated for this employee.';
  end if;

  -- Recompute from live server sources at mutation time; no browser amounts
  -- or stale preview values are accepted as inputs.
  v_calculation := public.payroll_v2_employee_calculation_payload(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
  if coalesce((v_calculation ->> 'ready_to_preview')::boolean, false) is not true
     or nullif(v_calculation ->> 'gross_pay', '') is null
     or nullif(v_calculation ->> 'net_pay', '') is null then
    raise exception using errcode = '55000',
      message = 'Payroll calculation is blocked. Resolve readiness and Agent Rate issues before calculating.';
  end if;

  v_read_model := public.payroll_v2_get_individual_payslip_data(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
  if v_read_model -> 'employee' ->> 'employee_user_id' <> p_employee_user_id::text
     or v_read_model -> 'period' ->> 'period_id' <> p_payroll_v2_period_id::text then
    raise exception using errcode = '22023',
      message = 'Payroll V2 employee or period did not match the requested calculation.';
  end if;

  v_snapshot := v_calculation || jsonb_build_object(
    'attendance_source_rows', coalesce(v_read_model -> 'attendance', '[]'::jsonb),
    'calculation_version', 'payroll_v2_employee_calculation_payload-v1'
  );

  insert into public.payroll_v2_records (
    payroll_v2_period_id,
    employee_user_id,
    status,
    calculated_at,
    calculation_snapshot
  ) values (
    p_payroll_v2_period_id,
    p_employee_user_id,
    'calculated',
    statement_timestamp(),
    v_snapshot
  ) returning id into v_record_id;

  -- One date-level attendance item preserves rate allocation and every source
  -- attendance/schedule identifier used for that payroll-facing work date.
  for v_day in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'daily_breakdown', '[]'::jsonb))
  loop
    if coalesce((v_day ->> 'payable_minutes')::integer, 0) > 0 then
      insert into public.payroll_v2_items (
        payroll_v2_record_id, item_type, description, work_date,
        source_type, source_id, minutes, rate, amount, metadata
      ) values (
        v_record_id,
        'attendance',
        'Attendance — ' || (v_day ->> 'work_date'),
        (v_day ->> 'work_date')::date,
        'workforce_attendance_payroll_readiness',
        nullif(v_day -> 'source_attendance_ids' ->> 0, '')::uuid,
        (v_day ->> 'payable_minutes')::integer,
        (v_day ->> 'hourly_rate')::numeric,
        (v_day ->> 'attendance_amount')::numeric(12,2),
        jsonb_build_object(
          'source_attendance_ids', coalesce(v_day -> 'source_attendance_ids', '[]'::jsonb),
          'source_schedule_ids', coalesce(v_day -> 'source_schedule_ids', '[]'::jsonb),
          'regular_minutes', coalesce(v_day -> 'regular_minutes', '0'::jsonb),
          'additional_minutes', coalesce(v_day -> 'additional_minutes', '0'::jsonb),
          'rate_id', v_day -> 'rate_id',
          'rate_effective_date', v_day -> 'rate_effective_date',
          'currency_code', v_day -> 'currency_code'
        )
      );
    end if;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'paid_leave_rows', '[]'::jsonb))
  loop
    select value into v_day
    from jsonb_array_elements(coalesce(v_calculation -> 'daily_breakdown', '[]'::jsonb))
    where value ->> 'work_date' = v_item ->> 'work_date'
    limit 1;
    insert into public.payroll_v2_items (
      payroll_v2_record_id, item_type, description, work_date,
      source_type, source_id, minutes, rate, amount, metadata
    ) values (
      v_record_id,
      'paid_leave',
      coalesce(nullif(v_item ->> 'leave_type', ''), 'Paid leave') || ' — ' || (v_item ->> 'work_date'),
      (v_item ->> 'work_date')::date,
      'work_schedule',
      nullif(v_item ->> 'source_schedule_id', '')::uuid,
      coalesce((v_item ->> 'paid_minutes')::integer, 0),
      (v_day ->> 'hourly_rate')::numeric,
      coalesce((v_day ->> 'leave_amount')::numeric, 0)::numeric(12,2),
      jsonb_build_object(
        'leave_type', v_item -> 'leave_type',
        'status', v_item -> 'status',
        'source_schedule_id', v_item -> 'source_schedule_id',
        'rate_id', v_day -> 'rate_id',
        'rate_effective_date', v_day -> 'rate_effective_date',
        'currency_code', v_day -> 'currency_code'
      )
    );
  end loop;

  for v_day in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'daily_breakdown', '[]'::jsonb))
  loop
    for v_target in
      select value from jsonb_array_elements(coalesce(v_day -> 'committed_hours_targets', '[]'::jsonb))
    loop
      select commitment.id into v_source_id
      from public.payroll_prepaid_commitments commitment
      where commitment.employee_id = p_employee_user_id
        and commitment.work_date = (v_target ->> 'work_date')::date
        and commitment.commitment_version = (v_target ->> 'commitment_version')::integer
        and commitment.superseded_at is null
      order by commitment.created_at desc
      limit 1;
      if v_source_id is null then
        raise exception using errcode = '55000',
          message = 'A Committed Hours source changed during calculation. Retry the calculation.';
      end if;

      insert into public.payroll_v2_committed_hours_snapshots (
        payroll_v2_record_id, employee_user_id, work_date, commitment_source_id,
        expected_committed_minutes, qualifying_approved_payroll_ready_minutes,
        covered_committed_minutes, remaining_committed_minutes, source_version, metadata
      ) values (
        v_record_id,
        p_employee_user_id,
        (v_target ->> 'work_date')::date,
        v_source_id,
        (v_target ->> 'expected_minutes')::integer,
        (v_target ->> 'payroll_ready_minutes')::integer,
        (v_target ->> 'covered_minutes')::integer,
        (v_target ->> 'remaining_minutes')::integer,
        'payroll_v2_get_individual_payslip_data/current',
        jsonb_build_object(
          'commitment_version', v_target -> 'commitment_version',
          'day_type', v_target -> 'day_type'
        )
      );

      if coalesce((v_target ->> 'remaining_minutes')::integer, 0) > 0 then
        insert into public.payroll_v2_items (
          payroll_v2_record_id, item_type, description, work_date,
          source_type, source_id, minutes, rate, amount, metadata
        ) values (
          v_record_id,
          'committed_hours',
          'Committed Hours — ' || (v_target ->> 'work_date'),
          (v_target ->> 'work_date')::date,
          'payroll_prepaid_commitments',
          v_source_id,
          (v_target ->> 'remaining_minutes')::integer,
          (v_day ->> 'hourly_rate')::numeric,
          coalesce((v_day ->> 'committed_hours_amount')::numeric, 0)::numeric(12,2),
          jsonb_build_object(
            'commitment_version', v_target -> 'commitment_version',
            'expected_minutes', v_target -> 'expected_minutes',
            'qualifying_approved_payroll_ready_minutes', v_target -> 'payroll_ready_minutes',
            'covered_minutes', v_target -> 'covered_minutes',
            'remaining_minutes', v_target -> 'remaining_minutes',
            'rate_id', v_day -> 'rate_id',
            'rate_effective_date', v_day -> 'rate_effective_date',
            'currency_code', v_day -> 'currency_code'
          )
        );
      end if;
    end loop;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'manual_earnings' -> 'rows', '[]'::jsonb))
    where coalesce((value ->> 'included_in_preview')::boolean, false)
  loop
    insert into public.payroll_v2_items (
      payroll_v2_record_id, item_type, description, source_type, source_id,
      amount, metadata
    ) values (
      v_record_id,
      'manual_earning',
      coalesce(nullif(v_item ->> 'description', ''), 'Manual earning'),
      'payroll_v2_manual_earnings',
      (v_item ->> 'id')::uuid,
      (v_item ->> 'amount')::numeric(12,2),
      jsonb_build_object('status', v_item -> 'status', 'currency_code', v_item -> 'currency_code')
    );
  end loop;

  -- Snapshot one attendance aggregation per actual payroll-facing work date.
  for v_row in
    select value
    from jsonb_array_elements(coalesce(v_snapshot -> 'attendance_source_rows', '[]'::jsonb))
    where (value ->> 'work_date')::date between v_period.period_start and v_period.period_end
      and jsonb_array_length(coalesce(value -> 'source_attendance_ids', '[]'::jsonb)) > 0
    order by value ->> 'work_date'
  loop
    select coalesce(array_agg(id::uuid), '{}'::uuid[])
      into v_source_attendance_ids
    from jsonb_array_elements_text(coalesce(v_row -> 'source_attendance_ids', '[]'::jsonb)) ids(id);
    select coalesce(array_agg(id::uuid), '{}'::uuid[])
      into v_source_schedule_ids
    from jsonb_array_elements_text(coalesce(v_row -> 'source_schedule_ids', '[]'::jsonb)) ids(id);

    insert into public.payroll_v2_attendance_snapshots (
      payroll_v2_record_id, employee_user_id, work_date,
      source_attendance_ids, source_schedule_ids, classification,
      regular_minutes, additional_minutes, payable_minutes,
      approval_state, payroll_readiness_state, payroll_readiness_blockers,
      billed_timestamps, schedule_details, source_rows, source_version, metadata
    ) values (
      v_record_id,
      p_employee_user_id,
      (v_row ->> 'work_date')::date,
      v_source_attendance_ids,
      v_source_schedule_ids,
      coalesce(nullif(v_row ->> 'attendance_type', ''), 'Unknown'),
      coalesce((v_row ->> 'regular_minutes')::integer, 0),
      coalesce((v_row ->> 'additional_ot_minutes')::integer, 0),
      coalesce((v_row ->> 'total_payable_minutes')::integer, 0),
      coalesce(nullif(v_row ->> 'approval_status', ''), 'Unknown'),
      case when coalesce((v_row ->> 'is_payroll_ready')::boolean, false) then 'Ready' else 'Blocked' end,
      array(select jsonb_array_elements_text(coalesce(v_row -> 'readiness_blockers', '[]'::jsonb))),
      coalesce(v_row -> 'billed_timestamps', '[]'::jsonb),
      coalesce((
        select jsonb_agg(to_jsonb(schedule) order by schedule.id)
        from public.work_schedules schedule
        where schedule.id = any(v_source_schedule_ids)
      ), '[]'::jsonb),
      jsonb_build_array(v_row),
      v_source_version,
      jsonb_build_object(
        'source_record_count', v_row -> 'source_record_count',
        'attendance_source_count', v_row -> 'attendance_source_count',
        'schedule_variants', coalesce(v_row -> 'schedule_variants', '[]'::jsonb),
        'source_approval_statuses', coalesce(v_row -> 'source_approval_statuses', '[]'::jsonb),
        'schedule_review_required', coalesce(v_row -> 'schedule_review_required', 'false'::jsonb)
      )
    );
  end loop;

  return v_snapshot || jsonb_build_object(
    'status', 'Calculated',
    'persistence', jsonb_build_object(
      'saved', true,
      'payroll_v2_record_id', v_record_id,
      'record_status', 'calculated',
      'message', 'Calculated Payroll V2 result loaded from its saved calculation and snapshots.'
    )
  );
exception
  when unique_violation then
    raise exception using errcode = '23505',
      message = 'Payroll already calculated for this employee.';
end;
$function$;

revoke all on function public.payroll_v2_calculate_employee(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_calculate_employee(uuid, uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_calculate_employee(uuid, uuid) is
  'Atomically computes and persists one ready employee Payroll V2 calculation. Never writes Payroll V1 tables or legacy prepaid balances.';

create or replace function public.payroll_v2_get_calculated_employee(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_record public.payroll_v2_records%rowtype;
  v_items jsonb;
  v_attendance_snapshots jsonb;
  v_commitment_snapshots jsonb;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view Payroll Dashboard V2 employee pay.';
  end if;

  select record.* into v_record
  from public.payroll_v2_records record
  where record.payroll_v2_period_id = p_payroll_v2_period_id
    and record.employee_user_id = p_employee_user_id
    and record.status <> 'void';
  if not found then return null; end if;

  select coalesce(jsonb_agg(to_jsonb(item) - 'created_at' order by item.work_date nulls last, item.created_at, item.id), '[]'::jsonb)
    into v_items
  from public.payroll_v2_items item
  where item.payroll_v2_record_id = v_record.id;
  select coalesce(jsonb_agg(to_jsonb(snapshot) - 'created_at' order by snapshot.work_date, snapshot.id), '[]'::jsonb)
    into v_attendance_snapshots
  from public.payroll_v2_attendance_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id;
  select coalesce(jsonb_agg(to_jsonb(snapshot) - 'created_at' order by snapshot.work_date, snapshot.id), '[]'::jsonb)
    into v_commitment_snapshots
  from public.payroll_v2_committed_hours_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id;

  return v_record.calculation_snapshot || jsonb_build_object(
    'status', case when v_record.status = 'calculated' then 'Calculated' else pg_catalog.initcap(v_record.status) end,
    'persistence', jsonb_build_object(
      'saved', true,
      'payroll_v2_record_id', v_record.id,
      'record_status', v_record.status,
      'calculated_at', v_record.calculated_at,
      'message', 'Calculated Payroll V2 result loaded from its saved calculation and snapshots.'
    ),
    'items', v_items,
    'attendance_snapshots', v_attendance_snapshots,
    'committed_hours_snapshots', v_commitment_snapshots
  );
end;
$function$;

revoke all on function public.payroll_v2_get_calculated_employee(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_get_calculated_employee(uuid, uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_get_calculated_employee(uuid, uuid) is
  'Returns the immutable saved Payroll V2 calculation, items, and snapshots; never recomputes from live source data.';

;
