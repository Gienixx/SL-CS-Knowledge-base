create or replace function public.workforce_get_management_page_references()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_profiles jsonb;
  v_teams jsonb;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception using
      errcode = '42501',
      message = 'You do not have permission to manage workforce users.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', profile.user_id,
        'full_name', profile.full_name,
        'email', profile.email,
        'employee_id', profile.employee_id,
        'employment_status', profile.employment_status,
        'onboarding_status', profile.onboarding_status,
        'invited_at', profile.invited_at,
        'invitation_last_sent_at', profile.invitation_last_sent_at,
        'restoration_invite_pending', profile.restoration_invite_pending,
        'account_deleted_at', profile.account_deleted_at,
        'base_role', profile.base_role,
        'is_agent', profile.is_agent,
        'is_system_admin', profile.is_system_admin,
        'team_id', profile.team_id,
        'supervisor_id', profile.supervisor_id,
        'can_edit_articles', profile.can_edit_articles,
        'can_manage_payroll', profile.can_manage_payroll,
        'timezone', profile.timezone,
        'updated_at', profile.updated_at,
        'user_permissions', coalesce(permission_rows.permissions, '[]'::jsonb)
      ) order by profile.full_name
    ),
    '[]'::jsonb
  )
  into v_profiles
  from public.profiles as profile
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'user_id', permission.user_id,
        'permission_key', permission.permission_key,
        'is_granted', permission.is_granted
      ) order by permission.permission_key
    ) as permissions
    from public.user_permissions as permission
    where permission.user_id = profile.user_id
  ) as permission_rows on true
  where profile.is_system_admin is false;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', team.id,
        'name', team.name,
        'description', team.description,
        'is_active', team.is_active,
        'updated_at', team.updated_at
      ) order by team.name
    ),
    '[]'::jsonb
  )
  into v_teams
  from public.teams as team;

  return jsonb_build_object(
    'profiles', v_profiles,
    'teams', v_teams
  );
end;
$function$;

revoke all on function public.workforce_get_management_page_references()
  from public, anon;
grant execute on function public.workforce_get_management_page_references()
  to authenticated;

;
