-- Return the current payroll-period view data for one employee after an
-- employee-scoped write. Existing Payroll readers remain authoritative for
-- their data; the wrapper materializes the permission-checked import-status
-- reader and filters all returned data to the requested employee.
create function public.payroll_get_employee_period_refresh_state(
  p_payroll_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  -- The readiness and missing-attendance read models are SECURITY DEFINER
  -- functions that do not all enforce payroll access themselves. Materialize
  -- an existing permission-checked reader so every wrapper call passes its
  -- canonical active-profile and payroll-permission checks.
  with permission_checked_import_status as materialized (
    select *
    from public.payroll_get_period_attendance_import_status(
      p_payroll_period_id
    )
  )
  select jsonb_build_object(
    'readiness', (
      select to_jsonb(readiness)
      from public.payroll_get_period_employee_readiness(
        p_payroll_period_id
      ) as readiness
      where readiness.employee_user_id = p_employee_user_id
    ),
    'missing_attendance', coalesce((
      select jsonb_agg(to_jsonb(missing) order by missing.work_date, missing.schedule_id)
      from public.payroll_get_period_missing_attendance(
        p_payroll_period_id
      ) as missing
      where missing.employee_user_id = p_employee_user_id
    ), '[]'::jsonb),
    'import_status', (
      select to_jsonb(import_status)
      from permission_checked_import_status as import_status
      where import_status.employee_user_id = p_employee_user_id
    ),
    'exceptions', coalesce((
      select jsonb_agg(
        to_jsonb(exception_row)
        order by exception_row.work_date nulls last, exception_row.exception_key
      )
      from public.payroll_get_period_exceptions(
        p_payroll_period_id
      ) as exception_row
      where exception_row.employee_user_id = p_employee_user_id
    ), '[]'::jsonb),
    'preplots', coalesce((
      select jsonb_agg(to_jsonb(preplot) order by preplot.work_date, preplot.schedule_id)
      from public.payroll_get_preplot_candidates(
        p_payroll_period_id
      ) as preplot
      where preplot.employee_user_id = p_employee_user_id
    ), '[]'::jsonb),
    'prepaid_balances', coalesce((
      select jsonb_agg(to_jsonb(balance) order by balance.work_date, balance.prepaid_hour_id)
      from public.payroll_get_period_prepaid_hours(
        p_payroll_period_id
      ) as balance
      where balance.employee_user_id = p_employee_user_id
    ), '[]'::jsonb),
    'calculations', coalesce((
      select jsonb_agg(to_jsonb(calculation))
      from public.payroll_get_period_calculation(
        p_payroll_period_id
      ) as calculation
      where calculation.employee_user_id = p_employee_user_id
    ), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(
        to_jsonb(adjustment)
        order by adjustment.created_at, adjustment.payroll_item_id
      )
      from public.payroll_get_period_adjustments(
        p_payroll_period_id
      ) as adjustment
      where adjustment.employee_user_id = p_employee_user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.payroll_get_employee_period_refresh_state(uuid, uuid)
  from public, anon;
grant execute on function public.payroll_get_employee_period_refresh_state(uuid, uuid)
  to authenticated, service_role;

comment on function public.payroll_get_employee_period_refresh_state(uuid, uuid) is
  'Returns one employee’s current payroll-period rows after a scoped write by composing authoritative Payroll readers behind an existing permission-checked access read.';

;
