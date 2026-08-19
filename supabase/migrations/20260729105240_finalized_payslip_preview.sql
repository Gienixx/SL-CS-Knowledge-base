-- Phase 2 Step 11: permission-scoped finalized payslip preview.
-- Private correction notes and adjustment reasons remain outside the result.

begin;

create or replace function public.payroll_get_payslip_number(
  p_payroll_record_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_number text;
begin
  select coalesce(
    payslip.payslip_number,
    'SL-' ||
      to_char(period.payment_date, 'YYYYMMDD') || '-' ||
      regexp_replace(
        upper(coalesce(nullif(profile.employee_id, ''), 'EMPLOYEE')),
        '[^A-Z0-9]+',
        '',
        'g'
      ) || '-' ||
      upper(substr(replace(record.id::text, '-', ''), 1, 8)) ||
      '-V' || greatest(period.finalization_version, 1)::text
  )
  into v_number
  from public.payroll_records as record
  join public.payroll_periods as period
    on period.id = record.payroll_period_id
  join public.profiles as profile
    on profile.user_id = record.employee_id
  left join public.payslips as payslip
    on payslip.payroll_record_id = record.id
  where record.id = p_payroll_record_id
    and record.status = 'finalized'
    and period.status = 'finalized';

  if v_number is null then
    raise exception
      using
        errcode = '55000',
        message = 'A payslip number is available only for finalized payroll.';
  end if;

  return v_number;
end;
$$;

revoke all on function public.payroll_get_payslip_number(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_payslip_number(uuid)
  to service_role;

create or replace function public.payroll_get_payslip_preview(
  p_payroll_record_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_employee public.profiles%rowtype;
  v_can_view_all boolean;
  v_can_view_rates boolean;
  v_is_own boolean;
  v_earnings jsonb;
  v_deductions jsonb;
  v_rates jsonb;
  v_prepaid_summary jsonb;
  v_payslip jsonb;
  v_reviewed_by_name text;
  v_approved_by_name text;
  v_finalized_by_name text;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using
        errcode = '42501',
        message = 'Authentication is required to view a payslip.';
  end if;

  if p_payroll_record_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll record is required.';
  end if;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = p_payroll_record_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payslip payroll record was not found.';
  end if;

  select period.*
  into strict v_period
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id;

  select employee.*
  into strict v_employee
  from public.profiles as employee
  where employee.user_id = v_record.employee_id;

  if v_record.status <> 'finalized'
     or v_period.status <> 'finalized'
     or v_record.finalized_at is null
     or v_period.finalized_at is null then
    raise exception
      using
        errcode = '55000',
        message = 'Payslip preview is available only after payroll finalization.';
  end if;

  v_can_view_all :=
    public.workforce_has_permission('view_all_payslips')
    or public.workforce_has_permission('review_payroll')
    or public.workforce_has_permission('finalize_payroll')
    or public.workforce_has_permission('export_payslips')
    or public.workforce_has_permission('reopen_payroll');

  v_is_own :=
    public.workforce_has_permission('view_own_payslips')
    and public.workforce_is_current_identity(v_record.employee_id);

  if not v_can_view_all and not v_is_own then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view this payslip.';
  end if;

  v_can_view_rates := v_can_view_all;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'item_code', item.item_code,
        'description', item.description,
        'work_date', item.work_date,
        'quantity', item.quantity,
        'unit_rate',
          case when v_can_view_rates then item.unit_rate else null end,
        'amount', item.amount,
        'is_manual', item.is_manual
      )
      order by
        item.work_date nulls last,
        item.item_code,
        item.created_at,
        item.id
    ),
    '[]'::jsonb
  )
  into v_earnings
  from public.payroll_items as item
  where item.payroll_record_id = v_record.id
    and item.item_type = 'earning';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'item_code', item.item_code,
        'description', item.description,
        'work_date', item.work_date,
        'quantity', item.quantity,
        'unit_rate',
          case when v_can_view_rates then item.unit_rate else null end,
        'amount', item.amount,
        'is_manual', item.is_manual,
        'informational_only',
          coalesce(
            (item.metadata ->> 'informational_only')::boolean,
            false
          )
      )
      order by
        item.work_date nulls last,
        item.item_code,
        item.created_at,
        item.id
    ),
    '[]'::jsonb
  )
  into v_deductions
  from public.payroll_items as item
  where item.payroll_record_id = v_record.id
    and item.item_type = 'deduction';

  if v_can_view_rates then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rate_id', rate.id,
          'effective_date', rate.effective_date,
          'hourly_rate', rate.hourly_rate,
          'daily_rate', rate.daily_rate,
          'monthly_rate', rate.monthly_rate,
          'overtime_rate', rate.overtime_rate,
          'holiday_rate', rate.holiday_rate
        )
        order by rate.effective_date, rate.id
      ),
      '[]'::jsonb
    )
    into v_rates
    from (
      select distinct rate.*
      from public.agent_rates as rate
      join public.payroll_items as item
        on item.rate_id = rate.id
      where item.payroll_record_id = v_record.id
    ) as rate;
  else
    v_rates := '[]'::jsonb;
  end if;

  select balance.value
  into v_prepaid_summary
  from jsonb_array_elements(
    coalesce(
      v_period.finalization_evidence -> 'prepaid_minute_balances',
      '[]'::jsonb
    )
  ) as balance(value)
  where balance.value ->> 'employee_id' = v_record.employee_id::text
  limit 1;

  v_prepaid_summary := coalesce(
    v_prepaid_summary,
    jsonb_build_object(
      'opening_minutes', 0,
      'added_minutes', v_record.prepaid_minutes,
      'applied_minutes', v_record.applied_prepaid_minutes,
      'closing_minutes',
        greatest(
          v_record.prepaid_minutes -
            v_record.applied_prepaid_minutes,
          0
        )
    )
  );

  select jsonb_build_object(
    'generated', true,
    'payslip_number', payslip.payslip_number,
    'generated_at', payslip.generated_at,
    'finalized_at', payslip.finalized_at
  )
  into v_payslip
  from public.payslips as payslip
  where payslip.payroll_record_id = v_record.id;

  select profile.full_name
  into v_reviewed_by_name
  from public.profiles as profile
  where profile.user_id = v_period.reviewed_by;

  select profile.full_name
  into v_approved_by_name
  from public.profiles as profile
  where profile.user_id = v_period.approved_by;

  select profile.full_name
  into v_finalized_by_name
  from public.profiles as profile
  where profile.user_id = v_period.finalized_by;

  return jsonb_build_object(
    'viewer_scope', case when v_can_view_all then 'payroll' else 'own' end,
    'can_view_rates', v_can_view_rates,
    'payslip_number',
      public.payroll_get_payslip_number(v_record.id),
    'pdf', coalesce(
      v_payslip,
      jsonb_build_object(
        'generated', false,
        'payslip_number',
          public.payroll_get_payslip_number(v_record.id)
      )
    ),
    'employee', jsonb_build_object(
      'user_id', v_employee.user_id,
      'employee_number', v_employee.employee_id,
      'full_name', v_employee.full_name,
      'email', v_employee.email
    ),
    'period', jsonb_build_object(
      'payroll_period_id', v_period.id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'payment_date', v_period.payment_date,
      'currency_code', v_period.currency_code,
      'rounding_rules', v_period.rounding_rules,
      'finalization_version', v_period.finalization_version
    ),
    'paid_minutes', jsonb_build_object(
      'regular_minutes', v_record.regular_minutes,
      'prepaid_minutes', v_record.prepaid_minutes,
      'applied_prepaid_minutes', v_record.applied_prepaid_minutes,
      'overtime_minutes', v_record.overtime_minutes,
      'rest_day_minutes', v_record.rest_day_overtime_minutes,
      'holiday_minutes', v_record.holiday_overtime_minutes,
      'late_minutes', v_record.late_minutes,
      'undertime_minutes', v_record.undertime_minutes
    ),
    'earnings', v_earnings,
    'deductions', v_deductions,
    'rates_used', v_rates,
    'totals', jsonb_build_object(
      'regular_earnings', v_record.basic_pay,
      'prepaid_scheduled_earnings', v_record.prepaid_pay,
      'overtime_earnings', v_record.overtime_pay,
      'rest_day_earnings', v_record.rest_day_pay,
      'holiday_earnings', v_record.holiday_pay,
      'other_earnings', v_record.other_earnings,
      'gross_pay', v_record.gross_pay,
      'total_deductions', v_record.total_deductions,
      'net_pay', v_record.net_pay
    ),
    'prepaid_summary', v_prepaid_summary,
    'approval', jsonb_build_object(
      'reviewed_by', v_period.reviewed_by,
      'reviewed_by_name', v_reviewed_by_name,
      'reviewed_at', v_period.reviewed_at,
      'approved_by', v_period.approved_by,
      'approved_by_name', v_approved_by_name,
      'approved_at', v_period.approved_at,
      'finalized_by', v_period.finalized_by,
      'finalized_by_name', v_finalized_by_name,
      'finalized_at', v_period.finalized_at,
      'finalization_version', v_period.finalization_version
    )
  );
end;
$$;

revoke all on function public.payroll_get_payslip_preview(uuid)
  from public, anon;
grant execute on function public.payroll_get_payslip_preview(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_payslip_number(uuid) is
  'Returns the stable finalized payslip number used by preview and future PDF generation. Internal only.';
comment on function public.payroll_get_payslip_preview(uuid) is
  'Returns one finalized employee payslip without private payroll notes. Payroll viewers can see effective rates; own-payslip viewers cannot.';

commit;
