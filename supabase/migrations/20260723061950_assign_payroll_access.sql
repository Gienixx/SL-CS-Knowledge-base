-- Phase 2 Step 3: approve the initial payroll users and establish the
-- read-access boundary for payroll data. Browser mutations remain closed until
-- their audited workflows are introduced in later Phase 2 steps.

begin;

do $$
declare
  v_approved_count integer;
begin
  select count(*)
  into v_approved_count
  from public.profiles profile
  where (
      lower(profile.email) = 'almar@eurekasurveys.com'
      or profile.is_system_admin is true
    )
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active';

  if v_approved_count <> 2 then
    raise exception
      'Expected exactly two active approved payroll users (Almar and the protected system administrator); found %.',
      v_approved_count;
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where lower(profile.email) = 'almar@eurekasurveys.com'
      and profile.employment_status in ('active', 'on_leave')
      and profile.onboarding_status = 'active'
  ) then
    raise exception 'The approved Almar payroll profile is missing or inactive.';
  end if;

  if (
    select count(*)
    from public.profiles profile
    where profile.is_system_admin is true
      and profile.employment_status in ('active', 'on_leave')
      and profile.onboarding_status = 'active'
  ) <> 1 then
    raise exception 'Expected exactly one active protected system administrator.';
  end if;
end;
$$;

with approved_users as (
  select profile.user_id
  from public.profiles profile
  where (
      lower(profile.email) = 'almar@eurekasurveys.com'
      or profile.is_system_admin is true
    )
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
),
payroll_permissions(permission_key) as (
  values
    ('manage_agent_rates'::text),
    ('create_payroll'::text),
    ('review_payroll'::text),
    ('finalize_payroll'::text),
    ('view_all_payslips'::text),
    ('view_own_payslips'::text),
    ('export_payslips'::text),
    ('reopen_payroll'::text)
)
insert into public.user_permissions (
  user_id,
  permission_key,
  is_granted,
  granted_by,
  reason
)
select
  approved_user.user_id,
  payroll_permission.permission_key,
  true,
  null,
  'Approved for Phase 2 payroll access by workspace owner'
from approved_users approved_user
cross join payroll_permissions payroll_permission
on conflict (user_id, permission_key) do update
set is_granted = true,
    granted_by = excluded.granted_by,
    reason = excluded.reason,
    updated_at = now();

grant select on table public.agent_rates to authenticated;
grant select on table public.payroll_periods to authenticated;
grant select on table public.payroll_records to authenticated;
grant select on table public.payroll_items to authenticated;
grant select on table public.payroll_attendance_snapshots to authenticated;
grant select on table public.payslips to authenticated;
grant select on table public.payroll_audit_logs to authenticated;

drop policy if exists "Payroll rate managers can view rates"
on public.agent_rates;
create policy "Payroll rate managers can view rates"
on public.agent_rates
for select
to authenticated
using (
  (select public.workforce_has_permission('manage_agent_rates'))
);

drop policy if exists "Authorized users can view payroll periods"
on public.payroll_periods;
create policy "Authorized users can view payroll periods"
on public.payroll_periods
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('view_own_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

drop policy if exists "Authorized users can view payroll records"
on public.payroll_records;
create policy "Authorized users can view payroll records"
on public.payroll_records
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    (select public.workforce_has_permission('view_own_payslips'))
    and public.workforce_is_current_identity(employee_id)
  )
);

drop policy if exists "Authorized users can view payroll items"
on public.payroll_items;
create policy "Authorized users can view payroll items"
on public.payroll_items
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    (select public.workforce_has_permission('view_own_payslips'))
    and exists (
      select 1
      from public.payroll_records payroll_record
      where payroll_record.id = payroll_items.payroll_record_id
        and public.workforce_is_current_identity(payroll_record.employee_id)
    )
  )
);

drop policy if exists "Payroll processors can view attendance snapshots"
on public.payroll_attendance_snapshots;
create policy "Payroll processors can view attendance snapshots"
on public.payroll_attendance_snapshots
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

drop policy if exists "Authorized users can view payslips"
on public.payslips;
create policy "Authorized users can view payslips"
on public.payslips
for select
to authenticated
using (
  (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    (select public.workforce_has_permission('view_own_payslips'))
    and public.workforce_is_current_identity(employee_id)
  )
);

drop policy if exists "Payroll processors can view payroll audit logs"
on public.payroll_audit_logs;
create policy "Payroll processors can view payroll audit logs"
on public.payroll_audit_logs
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('reopen_payroll'))
);

insert into public.payroll_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data,
  reason,
  metadata
)
select
  null,
  'payroll_access_approved',
  'profiles',
  profile.user_id,
  null,
  jsonb_build_object(
    'email', lower(profile.email),
    'is_system_admin', profile.is_system_admin,
    'permission_keys', jsonb_build_array(
      'manage_agent_rates',
      'create_payroll',
      'review_payroll',
      'finalize_payroll',
      'view_all_payslips',
      'view_own_payslips',
      'export_payslips',
      'reopen_payroll'
    )
  ),
  'Approved for Phase 2 payroll access by workspace owner',
  jsonb_build_object(
    'attendance_permission_implied', false,
    'general_admin_access_implied', false
  )
from public.profiles profile
where lower(profile.email) = 'almar@eurekasurveys.com'
   or profile.is_system_admin is true;

commit;
