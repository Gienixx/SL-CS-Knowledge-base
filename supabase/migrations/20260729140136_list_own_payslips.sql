-- Phase 2 Step 13: finalized payslip summaries for the current employee only.
-- Rates, private payroll notes, storage paths, and reconciliation ledgers are
-- intentionally excluded.

begin;

create or replace function public.payroll_list_my_payslips()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_result jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using
        errcode = '42501',
        message = 'Authentication is required to view payslips.';
  end if;

  if not public.workforce_has_permission('view_own_payslips') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view your payslips.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'payroll_record_id', record.id,
        'payslip_number', public.payroll_get_payslip_number(record.id),
        'period_start', period.period_start,
        'period_end', period.period_end,
        'payment_date', period.payment_date,
        'currency_code', period.currency_code,
        'gross_pay', record.gross_pay,
        'total_deductions', record.total_deductions,
        'net_pay', record.net_pay,
        'prepaid_summary', jsonb_build_object(
          'opening_minutes', coalesce(balance.opening_minutes, 0),
          'added_minutes', coalesce(balance.added_minutes, record.prepaid_minutes),
          'applied_minutes', coalesce(balance.applied_minutes, record.applied_prepaid_minutes),
          'closing_minutes', coalesce(balance.closing_minutes, greatest(record.prepaid_minutes - record.applied_prepaid_minutes, 0))
        ),
        'finalized_by_name', finalizer.full_name,
        'finalized_at', period.finalized_at,
        'pdf', jsonb_build_object(
          'generated', latest_version.id is not null,
          'document_version', latest_version.document_version,
          'generated_at', latest_version.generated_at
        )
      )
      order by period.payment_date desc, period.period_end desc, record.id
    ),
    '[]'::jsonb
  )
  into v_result
  from public.payroll_records as record
  join public.payroll_periods as period
    on period.id = record.payroll_period_id
  left join public.profiles as finalizer
    on finalizer.user_id = period.finalized_by
  left join lateral (
    select
      (entry.value ->> 'opening_minutes')::integer as opening_minutes,
      (entry.value ->> 'added_minutes')::integer as added_minutes,
      (entry.value ->> 'applied_minutes')::integer as applied_minutes,
      (entry.value ->> 'closing_minutes')::integer as closing_minutes
    from jsonb_array_elements(
      coalesce(period.finalization_evidence -> 'prepaid_minute_balances', '[]'::jsonb)
    ) as entry(value)
    where entry.value ->> 'employee_id' = record.employee_id::text
    limit 1
  ) as balance on true
  left join lateral (
    select version.id, version.document_version, version.generated_at
    from public.payslip_versions as version
    where version.payroll_record_id = record.id
    order by version.document_version desc
    limit 1
  ) as latest_version on true
  where record.status = 'finalized'
    and period.status = 'finalized'
    and record.finalized_at is not null
    and period.finalized_at is not null
    and public.workforce_is_current_identity(record.employee_id);

  return v_result;
end;
$$;

revoke all on function public.payroll_list_my_payslips()
  from public, anon;
grant execute on function public.payroll_list_my_payslips()
  to authenticated, service_role;

comment on function public.payroll_list_my_payslips() is
  'Returns only the current active employee''s finalized payslip summaries, without rates, private notes, storage paths, or reconciliation detail.';

commit;
