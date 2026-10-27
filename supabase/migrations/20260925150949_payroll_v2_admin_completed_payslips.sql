-- Read-only Payroll V2 admin access to completed individual payslips.
-- These RPCs read only saved payroll records, items, periods, and snapshots.

create or replace function public.payroll_v2_list_completed_payslips(
  p_payroll_v2_period_id uuid
)
returns table (
  payroll_v2_record_id uuid,
  employee_name text,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
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
      message = 'You do not have permission to view completed Payroll V2 payslips.';
  end if;

  if p_payroll_v2_period_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period ID is required.';
  end if;

  return query
  select
    record.id,
    coalesce(
      nullif(record.calculation_snapshot -> 'employee' ->> 'employee_name', ''),
      nullif(record.calculation_snapshot -> 'employee' ->> 'full_name', ''),
      nullif(record.calculation_snapshot -> 'employee' ->> 'name', ''),
      'Employee'
    ),
    pg_catalog.initcap(record.status)
  from public.payroll_v2_records record
  where record.payroll_v2_period_id = p_payroll_v2_period_id
    and record.status in ('approved', 'finalized')
    and (
      record.status = 'finalized'
      or (
        record.status = 'approved'
        and record.recalculation_pending_at is null
        and record.recalculation_pending_by is null
        and record.recalculation_pending_reason is null
      )
    )
    and record.calculation_snapshot ->> 'ready_to_preview' = 'true'
    and record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
      = record.employee_user_id::text
    and record.calculation_snapshot -> 'period' ->> 'period_id'
      = record.payroll_v2_period_id::text
    and jsonb_typeof(record.calculation_snapshot -> 'gross_pay') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'total_deductions') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'net_pay') = 'number'
  order by 2, 1;
end;
$function$;

revoke all on function public.payroll_v2_list_completed_payslips(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_list_completed_payslips(uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_list_completed_payslips(uuid) is
  'Lists only approved Payroll V2 payslips with no open recalculation and finalized payslips for one period. Read-only and payroll-permission gated.';

create or replace function public.payroll_v2_get_admin_completed_payslip(
  p_payroll_v2_record_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_record public.payroll_v2_records%rowtype;
  v_period public.payroll_v2_periods%rowtype;
  v_items jsonb;
  v_attendance_snapshots jsonb;
  v_committed_hours_snapshots jsonb;
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication is required to view Payroll V2 payslips.';
  end if;

  if not (
    public.workforce_has_permission('create_payroll')
    or public.workforce_has_permission('review_payroll')
    or public.workforce_has_permission('finalize_payroll')
    or public.workforce_has_permission('reopen_payroll')
    or public.workforce_has_permission('view_all_payslips')
    or public.workforce_has_permission('export_payslips')
  ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view completed Payroll V2 payslips.';
  end if;

  if p_payroll_v2_record_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 record ID is required.';
  end if;

  select record.*
    into v_record
  from public.payroll_v2_records record
  where record.id = p_payroll_v2_record_id
    and record.status in ('approved', 'finalized')
    and (
      record.status = 'finalized'
      or (
        record.status = 'approved'
        and record.recalculation_pending_at is null
        and record.recalculation_pending_by is null
        and record.recalculation_pending_reason is null
      )
    )
    and record.calculation_snapshot ->> 'ready_to_preview' = 'true'
    and record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
      = record.employee_user_id::text
    and record.calculation_snapshot -> 'period' ->> 'period_id'
      = record.payroll_v2_period_id::text
    and jsonb_typeof(record.calculation_snapshot -> 'gross_pay') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'total_deductions') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'net_pay') = 'number';

  if not found then
    return null;
  end if;

  select period.*
    into v_period
  from public.payroll_v2_periods period
  where period.id = v_record.payroll_v2_period_id;

  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'item_type', item.item_type,
        'description', item.description,
        'work_date', item.work_date,
        'minutes', item.minutes,
        'rate', item.rate,
        'amount', item.amount
      )
      order by item.work_date nulls last, item.created_at, item.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.payroll_v2_items item
  where item.payroll_v2_record_id = v_record.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', snapshot.work_date,
        'classification', snapshot.classification,
        'regular_minutes', snapshot.regular_minutes,
        'additional_minutes', snapshot.additional_minutes,
        'payable_minutes', snapshot.payable_minutes,
        'approval_state', snapshot.approval_state,
        'payroll_readiness_state', snapshot.payroll_readiness_state
      )
      order by snapshot.work_date, snapshot.id
    ),
    '[]'::jsonb
  )
  into v_attendance_snapshots
  from public.payroll_v2_attendance_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id
    and snapshot.employee_user_id = v_record.employee_user_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', snapshot.work_date,
        'expected_committed_minutes', snapshot.expected_committed_minutes,
        'qualifying_approved_payroll_ready_minutes', snapshot.qualifying_approved_payroll_ready_minutes,
        'covered_committed_minutes', snapshot.covered_committed_minutes,
        'remaining_committed_minutes', snapshot.remaining_committed_minutes
      )
      order by snapshot.work_date, snapshot.id
    ),
    '[]'::jsonb
  )
  into v_committed_hours_snapshots
  from public.payroll_v2_committed_hours_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id
    and snapshot.employee_user_id = v_record.employee_user_id;

  return jsonb_build_object(
    'payroll_v2_record_id', v_record.id,
    'status', pg_catalog.initcap(v_record.status),
    'approved_at', v_record.approved_at,
    'finalized_at', v_record.finalized_at,
    'employee', jsonb_build_object(
      'full_name', coalesce(
        nullif(v_record.calculation_snapshot -> 'employee' ->> 'employee_name', ''),
        nullif(v_record.calculation_snapshot -> 'employee' ->> 'full_name', ''),
        nullif(v_record.calculation_snapshot -> 'employee' ->> 'name', '')
      ),
      'employee_number', coalesce(
        v_record.calculation_snapshot -> 'employee' ->> 'employee_number',
        v_record.calculation_snapshot -> 'employee' ->> 'employee_id'
      )
    ),
    'period', jsonb_build_object(
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'payment_date', v_period.payment_date,
      'currency_code', v_record.calculation_snapshot ->> 'currency_code'
    ),
    'totals', jsonb_build_object(
      'total_payable_minutes', v_record.calculation_snapshot -> 'total_payable_minutes',
      'attendance_earnings', v_record.calculation_snapshot -> 'attendance_earnings',
      'paid_leave_earnings', v_record.calculation_snapshot -> 'paid_leave_earnings',
      'gross_pay', v_record.calculation_snapshot -> 'gross_pay',
      'total_deductions', v_record.calculation_snapshot -> 'total_deductions',
      'net_pay', v_record.calculation_snapshot -> 'net_pay'
    ),
    'items', v_items,
    'attendance_snapshots', v_attendance_snapshots,
    'committed_hours_snapshots', v_committed_hours_snapshots
  );
end;
$function$;

revoke all on function public.payroll_v2_get_admin_completed_payslip(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_get_admin_completed_payslip(uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_get_admin_completed_payslip(uuid) is
  'Returns a persisted Payroll V2 approved or finalized payslip to payroll-authorized users. Read-only; it never recalculates or reads live attendance, commitments, or agent rates.';

;
