-- Trigger helpers are internal database implementation details and must not be
-- callable through the Data API.
revoke all on function public.workforce_sync_admin_payroll_permission()
from public, anon, authenticated;

revoke all on function public.workforce_enforce_admin_payroll_profile()
from public, anon, authenticated;

grant execute on function public.workforce_sync_admin_payroll_permission()
to service_role;

grant execute on function public.workforce_enforce_admin_payroll_profile()
to service_role;
