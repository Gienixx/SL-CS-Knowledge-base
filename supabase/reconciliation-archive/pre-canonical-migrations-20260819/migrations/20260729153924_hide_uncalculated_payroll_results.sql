-- An eligible employee has a payroll record shell before calculation. Keep
-- those zero-value shells out of the calculation review until Step 7 has
-- actually populated and timestamped the record.

begin;

create or replace function public.payroll_get_period_calculation(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  record_status text,
  regular_minutes integer,
  prepaid_minutes integer,
  applied_prepaid_minutes integer,
  overtime_minutes integer,
  rest_day_minutes integer,
  holiday_minutes integer,
  late_minutes integer,
  undertime_minutes integer,
  basic_pay numeric,
  prepaid_pay numeric,
  overtime_pay numeric,
  rest_day_pay numeric,
  holiday_pay numeric,
  other_earnings numeric,
  gross_pay numeric,
  total_deductions numeric,
  net_pay numeric,
  currency_code text,
  calculation_version integer,
  calculated_at timestamptz,
  calculated_by_name text,
  line_item_count bigint,
  line_items jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view draft payroll calculations.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  return query
  select
    record.id,
    record.employee_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    record.status,
    record.regular_minutes,
    record.prepaid_minutes,
    record.applied_prepaid_minutes,
    record.overtime_minutes,
    record.rest_day_overtime_minutes,
    record.holiday_overtime_minutes,
    record.late_minutes,
    record.undertime_minutes,
    record.basic_pay,
    record.prepaid_pay,
    record.overtime_pay,
    record.rest_day_pay,
    record.holiday_pay,
    record.other_earnings,
    record.gross_pay,
    record.total_deductions,
    record.net_pay,
    record.currency_code,
    record.calculation_version,
    record.calculated_at,
    calculator.full_name,
    count(item.id),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', item.id,
          'item_type', item.item_type,
          'item_code', item.item_code,
          'description', item.description,
          'work_date', item.work_date,
          'quantity', item.quantity,
          'unit_rate', item.unit_rate,
          'amount', item.amount,
          'is_manual', item.is_manual,
          'rate_effective_date',
            item.metadata ->> 'rate_effective_date',
          'applied_prepaid_minutes',
            item.metadata ->> 'applied_prepaid_minutes',
          'informational_only',
            coalesce(
              (item.metadata ->> 'informational_only')::boolean,
              false
            )
        )
        order by
          item.work_date nulls last,
          item.item_type,
          item.item_code,
          item.created_at,
          item.id
      ) filter (where item.id is not null),
      '[]'::jsonb
    )
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  left join public.profiles as calculator
    on calculator.user_id = record.calculated_by
  left join public.payroll_items as item
    on item.payroll_record_id = record.id
  where record.payroll_period_id = p_payroll_period_id
    and record.status <> 'void'
    and record.calculated_at is not null
  group by
    record.id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    calculator.full_name
  order by profile.full_name, profile.email, record.id;
end;
$$;

revoke all on function public.payroll_get_period_calculation(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_calculation(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_calculation(uuid) is
  'Returns only calculated payroll-processor draft totals and lines. Empty payroll record shells and own-payslip viewers cannot see draft amounts.';

commit;
