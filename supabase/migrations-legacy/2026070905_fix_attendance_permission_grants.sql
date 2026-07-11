-- Fix non-admin attendance permission grants and remove duplicates
-- Revoke explicit 'correct_attendance' and 'approve_attendance' grants from non-admins,
-- remove duplicate permission rows, and ensure system admins have explicit grants.

begin;

-- 1) Revoke improper grants from non-admins (keeps system admins intact)
update public.user_permissions up
set is_granted = false,
    updated_at = now(),
    granted_by = null,
    reason = 'Revoked by migration: non-admins must not have attendance correction/approval'
from public.profiles p
where up.user_id = p.user_id
  and up.permission_key in ('correct_attendance','approve_attendance')
  and up.is_granted = true
  and p.base_role <> 'admin'
  and coalesce(p.is_system_admin, false) = false;

-- 2) Remove duplicate permission rows, keep the most recently updated (or created) row
with ranked as (
  select id,
         row_number() over (partition by user_id, permission_key order by coalesce(updated_at, created_at) desc) as rn
  from public.user_permissions
  where permission_key in ('correct_attendance','approve_attendance')
)
delete from public.user_permissions up
using ranked r
where up.id = r.id and r.rn > 1;

-- 3) Ensure system administrators have explicit grants for both keys
insert into public.user_permissions (user_id, permission_key, is_granted, granted_by, reason)
select profile.user_id, perm.permission_key, true, auth.uid(), 'System admin backfill by migration'
from public.profiles profile
cross join (values ('correct_attendance'::text), ('approve_attendance'::text)) as perm(permission_key)
where profile.is_system_admin is true
on conflict (user_id, permission_key) do update
set is_granted = true,
    updated_at = now();

-- 4) Record in the workforce audit logs for traceability
insert into public.workforce_audit_logs (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
values (
  auth.uid(),
  'fix_attendance_permission_grants',
  'user_permissions',
  null,
  null,
  jsonb_build_object('note', 'Revoked non-admin attendance grants and removed duplicate rows.'),
  'migration applied'
);

commit;
