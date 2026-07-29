-- Phase 2 Step 11 finalized payslip-preview deployment and privacy checks.
select
  to_regprocedure(
    'public.payroll_get_payslip_preview(uuid)'
  ) is not null as preview_function_exists_should_be_true,
  to_regprocedure(
    'public.payroll_get_payslip_number(uuid)'
  ) is not null as number_function_exists_should_be_true,
  has_function_privilege(
    'anon',
    'public.payroll_get_payslip_preview(uuid)',
    'execute'
  ) as anon_can_preview_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_get_payslip_preview(uuid)',
    'execute'
  ) as authenticated_can_preview_guarded_should_be_true,
  has_function_privilege(
    'authenticated',
    'public.payroll_get_payslip_number(uuid)',
    'execute'
  ) as authenticated_can_call_number_helper_should_be_false,
  has_function_privilege(
    'service_role',
    'public.payroll_get_payslip_number(uuid)',
    'execute'
  ) as service_role_can_call_number_helper_should_be_true;

select count(*) as private_note_reference_count_should_be_zero
from pg_proc as procedure
join pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'payroll_get_payslip_preview'
  and (
    pg_get_functiondef(procedure.oid) ~ '\mcorrection_notes\M'
    or pg_get_functiondef(procedure.oid) ~ '\madjustment_reason\M'
  );

select count(*) as invalid_preview_source_count_should_be_zero
from public.payroll_records as record
join public.payroll_periods as period
  on period.id = record.payroll_period_id
where record.status = 'finalized'
  and (
    period.status <> 'finalized'
    or record.finalized_at is null
    or period.finalized_at is null
  );

with generated_numbers as (
  select
    public.payroll_get_payslip_number(record.id) as payslip_number,
    count(*) over (
      partition by public.payroll_get_payslip_number(record.id)
    ) as number_count
  from public.payroll_records as record
  join public.payroll_periods as period
    on period.id = record.payroll_period_id
  where record.status = 'finalized'
    and period.status = 'finalized'
)
select count(*) as duplicate_generated_number_count_should_be_zero
from generated_numbers
where number_count > 1;
