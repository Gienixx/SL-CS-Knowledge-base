begin;

-- A protected owner is not part of the employee reporting hierarchy. Clear
-- legacy/circular supervisor data as a privileged migration operation so the
-- owner-protection trigger remains strict for authenticated requests.
update public.profiles
set supervisor_id = null,
    updated_at = now()
where is_system_admin is true
  and supervisor_id is not null;

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
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employee lifecycles.' using errcode = '42501';
  end if;
  if p_user_id is null or v_action not in ('deactivate', 'reactivate', 'delete') then
    raise exception 'Employee and a valid lifecycle action are required.';
  end if;

  select * into v_profile from public.profiles where user_id = p_user_id for update;
  if not found then raise exception 'Employee profile not found.'; end if;
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

  update public.profiles
  set employment_status = v_after_status,
      account_deleted_at = case when v_action = 'delete' then now() else account_deleted_at end,
      account_deleted_by = case when v_action = 'delete' then auth.uid() else account_deleted_by end,
      team_id = case when v_action = 'delete' then null else team_id end,
      supervisor_id = case when v_action in ('deactivate', 'delete') then null else supervisor_id end,
      updated_at = now()
  where user_id = p_user_id;

  if v_action in ('deactivate', 'delete') then
    update public.profiles
    set supervisor_id = null, updated_at = now()
    where supervisor_id = p_user_id
      and is_system_admin is false;
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    auth.uid(), 'employee_' || v_action || 'd', 'profiles', p_user_id,
    jsonb_build_object('employment_status', v_before_status, 'account_deleted_at', v_profile.account_deleted_at),
    jsonb_build_object('employment_status', v_after_status, 'account_deleted_at', case when v_action = 'delete' then now() else v_profile.account_deleted_at end),
    nullif(trim(coalesce(p_reason, '')), '')
  );

  return jsonb_build_object('user_id', p_user_id, 'action', v_action,
    'employment_status', v_after_status, 'history_preserved', true);
end;
$$;

revoke all on function public.workforce_admin_change_employee_lifecycle(uuid, text, text)
  from public, anon;
grant execute on function public.workforce_admin_change_employee_lifecycle(uuid, text, text)
  to authenticated;

insert into public.workforce_audit_logs (action, entity_type, after_data, reason)
values (
  'system_owner_reporting_hierarchy_corrected',
  'profiles',
  jsonb_build_object('system_owner_supervisor_cleared', true, 'lifecycle_cleanup_skips_system_owner', true),
  'Removed circular reporting assignment that blocked lifecycle cleanup for a former supervisor'
);

commit;
