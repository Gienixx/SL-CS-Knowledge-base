-- Workforce Management deployment Step 6: permission-matrix verification
--
-- Run this in the internal Supabase environment after all workforce migrations
-- through 2026070802_workforce_timezone_new_york.sql have been applied.
-- Every query marked "BLOCKER: should return 0 rows" must be empty before the
-- limited internal deployment. The script is read-only and rolls back.

begin;

create temporary table workforce_step6_candidates on commit drop as
with effective_permissions as (
  select
    profile.user_id,
    bool_or(permission.permission_key = 'manage_employees' and permission.is_granted) as manage_employees,
    bool_or(permission.permission_key = 'manage_schedules' and permission.is_granted) as manage_schedules,
    bool_or(permission.permission_key = 'view_team_attendance' and permission.is_granted) as view_team_attendance,
    bool_or(permission.permission_key = 'approve_leave' and permission.is_granted) as approve_leave,
    bool_or(permission.permission_key = 'view_workforce_reports' and permission.is_granted) as view_workforce_reports,
    bool_or(permission.permission_key = 'edit_articles' and permission.is_granted) as edit_articles,
    bool_or(permission.permission_key = 'manage_payroll' and permission.is_granted) as manage_payroll
  from public.profiles profile
  left join public.user_permissions permission on permission.user_id = profile.user_id
  group by profile.user_id
), categorized as (
  select
    'admin_agent'::text as category,
    profile.user_id,
    profile.full_name,
    profile.email,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    profile.team_id,
    profile.supervisor_id
  from public.profiles profile
  where profile.employment_status in ('active', 'on_leave')
    and profile.base_role = 'admin'
    and profile.is_agent is true

  union all

  select
    'admin_only',
    profile.user_id,
    profile.full_name,
    profile.email,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    profile.team_id,
    profile.supervisor_id
  from public.profiles profile
  where profile.employment_status in ('active', 'on_leave')
    and profile.base_role = 'admin'
    and profile.is_agent is false

  union all

  select
    'agent_editor',
    profile.user_id,
    profile.full_name,
    profile.email,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    profile.team_id,
    profile.supervisor_id
  from public.profiles profile
  join effective_permissions permission using (user_id)
  where profile.employment_status in ('active', 'on_leave')
    and profile.base_role = 'agent'
    and profile.is_agent is true
    and profile.is_system_admin is false
    and coalesce(permission.edit_articles, false) is true

  union all

  select
    'regular_agent',
    profile.user_id,
    profile.full_name,
    profile.email,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    profile.team_id,
    profile.supervisor_id
  from public.profiles profile
  join effective_permissions permission using (user_id)
  where profile.employment_status in ('active', 'on_leave')
    and profile.base_role = 'agent'
    and profile.is_agent is true
    and profile.is_system_admin is false
    and coalesce(permission.manage_employees, false) is false
    and coalesce(permission.manage_schedules, false) is false
    and coalesce(permission.view_team_attendance, false) is false
    and coalesce(permission.approve_leave, false) is false
    and coalesce(permission.view_workforce_reports, false) is false
    and coalesce(permission.edit_articles, false) is false
    and coalesce(permission.manage_payroll, false) is false

  union all

  select
    'team_supervisor',
    profile.user_id,
    profile.full_name,
    profile.email,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    profile.team_id,
    profile.supervisor_id
  from public.profiles profile
  join effective_permissions permission using (user_id)
  where profile.employment_status in ('active', 'on_leave')
    and profile.base_role = 'agent'
    and profile.is_agent is true
    and profile.is_system_admin is false
    and coalesce(permission.manage_schedules, false) is true
    and coalesce(permission.view_team_attendance, false) is true
    and coalesce(permission.approve_leave, false) is true
    and coalesce(permission.manage_employees, false) is false
    and (
      exists (
        select 1
        from public.profiles assigned
        where assigned.supervisor_id = profile.user_id
      )
      or exists (
        select 1
        from public.teams team
        where team.supervisor_id = profile.user_id
      )
    )
)
select
  categorized.*,
  row_number() over (
    partition by categorized.category
    order by categorized.full_name, categorized.email
  ) as candidate_rank
from categorized;

create temporary table workforce_step6_representatives on commit drop as
select *
from workforce_step6_candidates
where candidate_rank = 1;

create temporary table workforce_step6_expected_shape (
  category text primary key,
  expected_base_role text not null,
  expected_is_admin boolean not null,
  expected_is_agent boolean not null
) on commit drop;

insert into workforce_step6_expected_shape values
  ('admin_agent',    'admin', true,  true),
  ('admin_only',     'admin', true,  false),
  ('agent_editor',   'agent', false, true),
  ('regular_agent',  'agent', false, true),
  ('team_supervisor','agent', false, true);

create temporary table workforce_step6_expected_permissions (
  category text not null,
  permission_key text not null,
  expected_is_granted boolean not null,
  primary key (category, permission_key)
) on commit drop;

insert into workforce_step6_expected_permissions values
  ('admin_agent', 'manage_employees', true),
  ('admin_agent', 'manage_schedules', true),
  ('admin_agent', 'view_team_attendance', true),
  ('admin_agent', 'approve_leave', true),
  ('admin_agent', 'view_workforce_reports', true),

  ('admin_only', 'manage_employees', true),
  ('admin_only', 'manage_schedules', true),
  ('admin_only', 'view_team_attendance', true),
  ('admin_only', 'approve_leave', true),
  ('admin_only', 'view_workforce_reports', true),

  ('agent_editor', 'manage_employees', false),
  ('agent_editor', 'manage_schedules', false),
  ('agent_editor', 'view_team_attendance', false),
  ('agent_editor', 'approve_leave', false),
  ('agent_editor', 'view_workforce_reports', false),
  ('agent_editor', 'edit_articles', true),
  ('agent_editor', 'manage_payroll', false),

  ('regular_agent', 'manage_employees', false),
  ('regular_agent', 'manage_schedules', false),
  ('regular_agent', 'view_team_attendance', false),
  ('regular_agent', 'approve_leave', false),
  ('regular_agent', 'view_workforce_reports', false),
  ('regular_agent', 'edit_articles', false),
  ('regular_agent', 'manage_payroll', false),

  ('team_supervisor', 'manage_employees', false),
  ('team_supervisor', 'manage_schedules', true),
  ('team_supervisor', 'view_team_attendance', true),
  ('team_supervisor', 'approve_leave', true);

-- 1. BLOCKER: should return 0 rows.
-- A representative internal-test identity must exist for every supported scope.
select
  expected.category,
  count(candidate.user_id)::integer as candidate_count
from workforce_step6_expected_shape expected
left join workforce_step6_candidates candidate using (category)
group by expected.category
having count(candidate.user_id) = 0
order by expected.category;

-- 2. Review the representative identities selected for the test cycle.
-- Expected: five rows, one for each category.
select
  representative.category,
  representative.full_name,
  representative.email,
  representative.base_role,
  representative.is_agent,
  representative.is_system_admin,
  team.name as team_name,
  supervisor.full_name as supervisor_name
from workforce_step6_representatives representative
left join public.teams team on team.id = representative.team_id
left join public.profiles supervisor on supervisor.user_id = representative.supervisor_id
order by representative.category;

-- 3. BLOCKER: should return 0 rows.
-- Confirm the database profile shape matches the intended user type.
select
  representative.category,
  representative.full_name,
  representative.email,
  expected.expected_base_role,
  representative.base_role as actual_base_role,
  expected.expected_is_admin,
  (representative.base_role = 'admin' or representative.is_system_admin) as actual_is_admin,
  expected.expected_is_agent,
  representative.is_agent as actual_is_agent
from workforce_step6_representatives representative
join workforce_step6_expected_shape expected using (category)
where representative.base_role is distinct from expected.expected_base_role
   or (representative.base_role = 'admin' or representative.is_system_admin)
      is distinct from expected.expected_is_admin
   or representative.is_agent is distinct from expected.expected_is_agent
order by representative.category;

-- 4. BLOCKER: should return 0 rows.
-- Explicit grants must match the supported permission matrix. Missing rows count
-- as false, so revocation remains authoritative even for administrators.
select
  representative.category,
  representative.full_name,
  representative.email,
  expected.permission_key,
  expected.expected_is_granted,
  coalesce(permission.is_granted, false) as actual_is_granted,
  permission.reason
from workforce_step6_representatives representative
join workforce_step6_expected_permissions expected using (category)
left join public.user_permissions permission
  on permission.user_id = representative.user_id
 and permission.permission_key = expected.permission_key
where coalesce(permission.is_granted, false) is distinct from expected.expected_is_granted
order by representative.category, expected.permission_key;

create temporary table workforce_step6_rpc_results (
  category text primary key,
  user_id uuid not null,
  access_payload jsonb
) on commit drop;

do $$
declare
  identity record;
  access_result jsonb;
begin
  for identity in
    select category, user_id, email
    from workforce_step6_representatives
    order by category
  loop
    perform set_config('request.jwt.claim.sub', identity.user_id::text, true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub', identity.user_id,
        'email', identity.email,
        'role', 'authenticated'
      )::text,
      true
    );

    select public.workforce_get_current_access()
    into access_result;

    insert into workforce_step6_rpc_results (category, user_id, access_payload)
    values (identity.category, identity.user_id, access_result);
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- 5. BLOCKER: should return 0 rows.
-- Browser/Pages authorization receives the same role and agent flags as the
-- database profile selected above.
select
  representative.category,
  representative.email,
  result.access_payload
from workforce_step6_representatives representative
join workforce_step6_expected_shape expected using (category)
left join workforce_step6_rpc_results result using (category, user_id)
where result.access_payload is null
   or coalesce((result.access_payload ->> 'is_active')::boolean, false) is not true
   or (result.access_payload ->> 'base_role') is distinct from expected.expected_base_role
   or coalesce((result.access_payload ->> 'is_admin')::boolean, false)
      is distinct from expected.expected_is_admin
   or coalesce((result.access_payload ->> 'is_agent')::boolean, false)
      is distinct from expected.expected_is_agent
order by representative.category;

-- 6. BLOCKER: should return 0 rows.
-- The effective RPC permission payload must match explicit user_permissions.
select
  representative.category,
  representative.email,
  expected.permission_key,
  expected.expected_is_granted,
  coalesce(
    (result.access_payload -> 'permissions' ->> expected.permission_key)::boolean,
    false
  ) as rpc_is_granted
from workforce_step6_representatives representative
join workforce_step6_expected_permissions expected using (category)
join workforce_step6_rpc_results result using (category, user_id)
where coalesce(
        (result.access_payload -> 'permissions' ->> expected.permission_key)::boolean,
        false
      ) is distinct from expected.expected_is_granted
order by representative.category, expected.permission_key;

-- 7. BLOCKER: should return 0 rows.
-- The supervisor test identity needs both an assigned target and an unrelated
-- target so positive and negative team-scope tests are meaningful.
with supervisor as (
  select user_id
  from workforce_step6_representatives
  where category = 'team_supervisor'
), scope_counts as (
  select
    supervisor.user_id,
    count(*) filter (
      where target.supervisor_id = supervisor.user_id
         or team.supervisor_id = supervisor.user_id
    ) as assigned_targets,
    count(*) filter (
      where target.user_id <> supervisor.user_id
        and coalesce(target.supervisor_id, '00000000-0000-0000-0000-000000000000'::uuid) <> supervisor.user_id
        and coalesce(team.supervisor_id, '00000000-0000-0000-0000-000000000000'::uuid) <> supervisor.user_id
    ) as unrelated_targets
  from supervisor
  cross join public.profiles target
  left join public.teams team on team.id = target.team_id
  group by supervisor.user_id
)
select *
from scope_counts
where assigned_targets = 0 or unrelated_targets = 0;

-- 8. BLOCKER: should return 0 rows.
-- All workforce tables must have RLS enabled.
with required_tables(table_name) as (
  values
    ('teams'::text),
    ('profiles'::text),
    ('user_permissions'::text),
    ('work_schedules'::text),
    ('attendance'::text),
    ('leave_requests'::text),
    ('workforce_audit_logs'::text)
)
select required.table_name
from required_tables required
left join pg_class relation
  on relation.relname = required.table_name
left join pg_namespace namespace
  on namespace.oid = relation.relnamespace
 and namespace.nspname = 'public'
where relation.oid is null or relation.relrowsecurity is not true
order by required.table_name;

-- 9. BLOCKER: should return 0 rows.
-- Anonymous users must have no table access and no permission-RPC execution.
with required_tables(table_name) as (
  values
    ('teams'::text),
    ('profiles'::text),
    ('user_permissions'::text),
    ('work_schedules'::text),
    ('attendance'::text),
    ('leave_requests'::text),
    ('workforce_audit_logs'::text)
)
select required.table_name, privilege.privilege_type
from required_tables required
cross join lateral (
  values
    ('SELECT'::text),
    ('INSERT'::text),
    ('UPDATE'::text),
    ('DELETE'::text)
) privilege(privilege_type)
where has_table_privilege(
  'anon',
  format('public.%I', required.table_name),
  privilege.privilege_type
)
union all
select 'workforce_get_current_access()', 'EXECUTE'
where has_function_privilege(
  'anon',
  'public.workforce_get_current_access()',
  'EXECUTE'
)
order by 1, 2;

-- 10. BLOCKER: should return 0 rows.
-- Authenticated execution is required for the central access and attendance RPCs.
with required_functions(function_signature) as (
  values
    ('public.workforce_get_current_access()'::text),
    ('public.workforce_clock_in(uuid)'::text),
    ('public.workforce_clock_out()'::text)
)
select function_signature
from required_functions
where not has_function_privilege('authenticated', function_signature, 'EXECUTE')
order by function_signature;

-- 11. Review active workforce coverage before browser/API execution.
select
  count(*) filter (where employment_status in ('active', 'on_leave')) as active_or_on_leave_profiles,
  count(*) filter (where base_role = 'admin' and employment_status in ('active', 'on_leave')) as active_admin_profiles,
  count(*) filter (where is_agent is true and employment_status in ('active', 'on_leave')) as active_agent_profiles,
  count(*) filter (where is_system_admin is true and employment_status in ('active', 'on_leave')) as active_system_admin_profiles
from public.profiles;

rollback;
