-- Restore the team administration RPC referenced by team-management.js.
-- The consolidated remote baseline retained the UI and verification contract,
-- but omitted this function from the live schema.

begin;

create or replace function public.workforce_admin_save_team(
  p_team_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_supervisor_id uuid default null,
  p_is_active boolean default true,
  p_reason text default null
)
returns public.teams
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result public.teams%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage teams.' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'Team name is required.';
  end if;

  if p_supervisor_id is not null and not exists (
    select 1
    from public.profiles supervisor
    where supervisor.user_id = p_supervisor_id
      and supervisor.employment_status in ('active', 'on_leave')
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  if p_team_id is null then
    insert into public.teams (
      name, description, supervisor_id, is_active, created_by, updated_by
    ) values (
      v_name, v_description, p_supervisor_id, coalesce(p_is_active, true),
      v_actor, v_actor
    )
    returning * into v_result;
  else
    update public.teams
    set name = v_name,
        description = v_description,
        supervisor_id = p_supervisor_id,
        is_active = coalesce(p_is_active, true),
        updated_by = v_actor
    where id = p_team_id
    returning * into v_result;

    if not found then
      raise exception 'Team not found.';
    end if;
  end if;

  if v_reason is not null then
    insert into public.workforce_audit_logs (
      actor_user_id, action, entity_type, entity_id, reason
    ) values (
      v_actor,
      case when p_team_id is null then 'create_note' else 'update_note' end,
      'teams',
      v_result.id,
      v_reason
    );
  end if;

  return v_result;
end;
$$;

comment on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) is 'Creates or updates a workforce team through an authorized transaction.';

revoke all on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) from public, anon;
grant execute on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
