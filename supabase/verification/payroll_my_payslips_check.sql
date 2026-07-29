select
  has_function_privilege(
    'anon',
    'public.payroll_list_my_payslips()',
    'execute'
  ) as anon_can_list_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_list_my_payslips()',
    'execute'
  ) as authenticated_can_list_guarded_should_be_true;

select
  procedure.prosecdef as uses_security_definer_should_be_true,
  position(
    'workforce_is_current_identity' in pg_get_functiondef(procedure.oid)
  ) > 0 as enforces_current_identity_should_be_true,
  position(
    'view_own_payslips' in pg_get_functiondef(procedure.oid)
  ) > 0 as requires_own_permission_should_be_true,
  position(
    'record.status = ''finalized''' in pg_get_functiondef(procedure.oid)
  ) > 0 as requires_finalized_record_should_be_true,
  position(
    'period.status = ''finalized''' in pg_get_functiondef(procedure.oid)
  ) > 0 as requires_finalized_period_should_be_true,
  position(
    'storage_path' in pg_get_functiondef(procedure.oid)
  ) = 0 as storage_path_reference_count_should_be_zero,
  position(
    'adjustment_reason' in pg_get_functiondef(procedure.oid)
  ) = 0 as adjustment_reason_reference_count_should_be_zero,
  position(
    'correction_notes' in pg_get_functiondef(procedure.oid)
  ) = 0 as correction_note_reference_count_should_be_zero,
  position(
    'agent_rates' in pg_get_functiondef(procedure.oid)
  ) = 0 as rate_reference_count_should_be_zero
from pg_proc as procedure
join pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'payroll_list_my_payslips'
  and pg_get_function_identity_arguments(procedure.oid) = '';
