-- CREATE OR REPLACE VIEW preserves existing ACLs. Remove the legacy writable
-- grants and expose the payroll-readiness projection as read-only data.

revoke all on public.workforce_attendance_payroll_readiness
  from public, anon, authenticated, service_role;

grant select on public.workforce_attendance_payroll_readiness
  to authenticated, service_role;
