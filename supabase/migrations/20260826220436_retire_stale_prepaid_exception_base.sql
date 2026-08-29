-- The public payroll_get_period_exceptions(uuid) RPC is now the canonical
-- exception reader.  This historical implementation is retained so old
-- database references do not fail, but it has no application callers and must
-- not remain an executable stale prepaid reader.
begin;

revoke all on function public.payroll_get_period_exceptions_complete_base(uuid)
  from public, anon, authenticated, service_role;

comment on function public.payroll_get_period_exceptions_complete_base(uuid) is
  'Retained for database compatibility only; retired from application use. Use payroll_get_period_exceptions(uuid), which is the canonical effective prepaid exception reader.';

commit;
