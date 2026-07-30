begin;

create or replace function public.workforce_admin_change_employee_lifecycle(
  p_user_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_before_status text;
  v_after_status text;
  v_deleted_email text;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employee lifecycles.' using errcode = '42501';
  end if;
  if p_user_id is null or v_action not in ('deactivate', 'reactivate', 'delete') then
    raise exception 'Employee and a valid lifecycle action are required.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Employee profile not found.';
  end if;
  if v_profile.is_system_admin then
    raise exception 'The protected system owner cannot be deactivated or deleted.' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change the lifecycle of your own administrator account.' using errcode = '42501';
  end if;
  if v_profile.account_deleted_at is not null and v_action <> 'delete' then
    raise exception 'A deleted Auth account cannot be reactivated; send a new invitation instead.';
  end if;

  v_before_status := v_profile.employment_status;
  v_after_status := case v_action
    when 'deactivate' then 'inactive'
    when 'reactivate' then 'active'
    when 'delete' then 'terminated'
  end;
  v_deleted_email := 'deleted-' || replace(p_user_id::text, '-', '') || '@deleted.invalid';

  if v_action = 'delete' then
    delete from public.login
    where lower(email) = lower(v_profile.email);
  end if;

  update public.profiles
  set employment_status = v_after_status,
      email = case when v_action = 'delete' then v_deleted_email else email end,
      account_deleted_at = case when v_action = 'delete' then now() else account_deleted_at end,
      account_deleted_by = case when v_action = 'delete' then auth.uid() else account_deleted_by end,
      team_id = case when v_action = 'delete' then null else team_id end,
      supervisor_id = case when v_action in ('deactivate', 'delete') then null else supervisor_id end,
      updated_at = now()
  where user_id = p_user_id;

  if v_action = 'delete' then
    update public.workforce_identity_links
    set is_active = false,
        updated_at = now()
    where profile_user_id = p_user_id;
  end if;

  if v_action in ('deactivate', 'delete') then
    update public.profiles
    set supervisor_id = null,
        updated_at = now()
    where supervisor_id = p_user_id
      and is_system_admin is false;
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    auth.uid(),
    'employee_' || v_action || 'd',
    'profiles',
    p_user_id,
    jsonb_build_object(
      'employment_status', v_before_status,
      'account_deleted_at', v_profile.account_deleted_at
    ),
    jsonb_build_object(
      'employment_status', v_after_status,
      'account_deleted_at',
      case when v_action = 'delete' then now() else v_profile.account_deleted_at end,
      'email_released', v_action = 'delete'
    ),
    nullif(trim(coalesce(p_reason, '')), '')
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'action', v_action,
    'employment_status', v_after_status,
    'history_preserved', true,
    'email_released', v_action = 'delete'
  );
end;
$$;

revoke all on function public.workforce_admin_change_employee_lifecycle(
  uuid, text, text
) from public, anon;
grant execute on function public.workforce_admin_change_employee_lifecycle(
  uuid, text, text
) to authenticated;

-- Repair accounts deleted before this change. Their workforce history and
-- stable user IDs remain, while the real email becomes reusable.
delete from public.login login_row
using public.profiles profile
where profile.account_deleted_at is not null
  and lower(login_row.email) = lower(profile.email);

update public.profiles
set email = 'deleted-' || replace(user_id::text, '-', '') || '@deleted.invalid',
    updated_at = now()
where account_deleted_at is not null
  and email <> 'deleted-' || replace(user_id::text, '-', '') || '@deleted.invalid';

update public.workforce_identity_links identity_link
set is_active = false,
    updated_at = now()
from public.profiles profile
where profile.user_id = identity_link.profile_user_id
  and profile.account_deleted_at is not null
  and identity_link.is_active is true;

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
select
  'deleted_employee_emails_released',
  'profiles',
  jsonb_build_object(
    'deleted_profiles_repaired', count(*),
    'real_emails_removed_from_active_identity_tables', true
  ),
  'Released reusable email addresses while preserving employee history'
from public.profiles
where account_deleted_at is not null;

commit;
