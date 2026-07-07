-- Workforce identity-link security verification companion
--
-- Run after workforce_permission_matrix_check.sql. Every query below is a
-- deployment blocker and must return 0 rows. This script is read-only.

begin;

-- 1. BLOCKER: should return 0 rows.
-- The identity-link table must exist and have Row-Level Security enabled.
select
  'public.workforce_identity_links'::text as resource,
  case
    when to_regclass('public.workforce_identity_links') is null then 'missing table'
    else 'row-level security disabled'
  end as failure
where to_regclass('public.workforce_identity_links') is null
   or not coalesce((
     select relation.relrowsecurity
     from pg_class relation
     where relation.oid = to_regclass('public.workforce_identity_links')
   ), false);

-- 2. BLOCKER: should return 0 rows.
-- Identity-link rows must not be directly accessible to anon or authenticated.
with roles(role_name) as (
  values ('anon'::text), ('authenticated'::text)
), privileges(privilege_type) as (
  values
    ('SELECT'::text),
    ('INSERT'::text),
    ('UPDATE'::text),
    ('DELETE'::text)
)
select
  roles.role_name,
  'public.workforce_identity_links'::text as resource,
  privileges.privilege_type
from roles
cross join privileges
where coalesce(
  has_table_privilege(
    roles.role_name,
    to_regclass('public.workforce_identity_links'),
    privileges.privilege_type
  ),
  false
)
order by roles.role_name, privileges.privilege_type;

-- 3. BLOCKER: should return 0 rows.
-- The linked-identity helper must exist, be executable by authenticated users,
-- and remain unavailable to anonymous users.
select
  'public.workforce_is_current_identity(uuid)'::text as function_signature,
  case
    when to_regprocedure('public.workforce_is_current_identity(uuid)') is null
      then 'missing function'
    when not coalesce(
      has_function_privilege(
        'authenticated',
        to_regprocedure('public.workforce_is_current_identity(uuid)'),
        'EXECUTE'
      ),
      false
    ) then 'authenticated cannot execute'
    when coalesce(
      has_function_privilege(
        'anon',
        to_regprocedure('public.workforce_is_current_identity(uuid)'),
        'EXECUTE'
      ),
      false
    ) then 'anon can execute'
  end as failure
where to_regprocedure('public.workforce_is_current_identity(uuid)') is null
   or not coalesce(
     has_function_privilege(
       'authenticated',
       to_regprocedure('public.workforce_is_current_identity(uuid)'),
       'EXECUTE'
     ),
     false
   )
   or coalesce(
     has_function_privilege(
       'anon',
       to_regprocedure('public.workforce_is_current_identity(uuid)'),
       'EXECUTE'
     ),
     false
   );

rollback;
