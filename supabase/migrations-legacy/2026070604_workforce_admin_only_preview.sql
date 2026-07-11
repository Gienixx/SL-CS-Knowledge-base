-- Phase 1 temporary admin-only preview
--
-- Workforce records are visible only to authenticated administrator profiles
-- while the interfaces are being built and reviewed. Agent and supervisor
-- self-service visibility will be enabled in a later migration.

-- Teams
drop policy if exists "Workforce users can view relevant teams" on public.teams;
drop policy if exists "Admins can view workforce teams" on public.teams;
create policy "Admins can view workforce teams"
on public.teams
for select
to authenticated
using (public.workforce_is_admin());

-- Profiles
drop policy if exists "Users can view permitted workforce profiles" on public.profiles;
drop policy if exists "Admins can view workforce profiles" on public.profiles;
create policy "Admins can view workforce profiles"
on public.profiles
for select
to authenticated
using (public.workforce_is_admin());

-- Permissions
drop policy if exists "Users can view their own permissions" on public.user_permissions;
drop policy if exists "Admins can view workforce permissions" on public.user_permissions;
create policy "Admins can view workforce permissions"
on public.user_permissions
for select
to authenticated
using (public.workforce_is_admin());

-- Schedules
drop policy if exists "Users can view permitted work schedules" on public.work_schedules;
drop policy if exists "Admins can view work schedules" on public.work_schedules;
create policy "Admins can view work schedules"
on public.work_schedules
for select
to authenticated
using (public.workforce_is_admin());

-- Attendance
drop policy if exists "Users can view permitted attendance" on public.attendance;
drop policy if exists "Admins can view attendance" on public.attendance;
create policy "Admins can view attendance"
on public.attendance
for select
to authenticated
using (public.workforce_is_admin());

-- Leave requests
drop policy if exists "Users can view permitted leave requests" on public.leave_requests;
drop policy if exists "Admins can view leave requests" on public.leave_requests;
create policy "Admins can view leave requests"
on public.leave_requests
for select
to authenticated
using (public.workforce_is_admin());

-- Audit logs
drop policy if exists "Workforce admins can view audit logs" on public.workforce_audit_logs;
drop policy if exists "Admins can view workforce audit logs" on public.workforce_audit_logs;
create policy "Admins can view workforce audit logs"
on public.workforce_audit_logs
for select
to authenticated
using (public.workforce_is_admin());
