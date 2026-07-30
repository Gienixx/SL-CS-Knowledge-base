-- Controlled deleted-employee reinvite verification.

select
  to_regclass('private.workforce_deleted_employee_identities') is not null
    as deleted_identity_table_exists,
  to_regclass('private.workforce_deleted_employee_reinvites') is not null
    as reinvite_request_table_exists,
  to_regprocedure(
    'public.workforce_service_get_deleted_employee_reinvite(uuid,uuid,text)'
  ) is not null as candidate_service_exists,
  to_regprocedure(
    'public.workforce_service_prepare_deleted_employee_reinvite(uuid,uuid,uuid,text)'
  ) is not null as prepare_service_exists,
  to_regprocedure(
    'private.workforce_restore_deleted_employee_after_invite_acceptance()'
  ) is not null as acceptance_trigger_function_exists;

select
  profile.user_id,
  profile.employee_id,
  profile.account_deleted_at,
  deleted_identity.deleted_at,
  deleted_identity.restored_at,
  octet_length(deleted_identity.email_hash) as email_hash_bytes
from public.profiles profile
left join private.workforce_deleted_employee_identities deleted_identity
  on deleted_identity.profile_user_id = profile.user_id
where profile.account_deleted_at is not null
order by profile.employee_id;

select
  reinvite.profile_user_id,
  reinvite.auth_user_id,
  reinvite.status,
  reinvite.requested_at,
  reinvite.last_sent_at,
  reinvite.accepted_at,
  reinvite.completed_at
from private.workforce_deleted_employee_reinvites reinvite
order by reinvite.requested_at desc;

select
  trigger_name,
  event_manipulation,
  action_timing
from information_schema.triggers
where event_object_schema = 'users'
  and trigger_name in (
    'auth_user_restore_deleted_employee_after_invite_acceptance',
    'auth_user_complete_invited_profile'
  )
order by trigger_name;

select
  routine_schema,
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_name in (
  'workforce_service_get_deleted_employee_reinvite',
  'workforce_service_prepare_deleted_employee_reinvite',
  'workforce_service_mark_deleted_employee_reinvite_resent'
)
order by routine_name, grantee;
