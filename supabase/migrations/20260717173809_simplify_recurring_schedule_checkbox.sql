-- Make weekly repetition incremental: each checked schedule entry is added to
-- the employee template without requiring a prebuilt Sunday-Saturday week.

begin;

create or replace function public.workforce_admin_add_schedule_to_weekly_template(
  p_schedule_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_schedule public.work_schedules%rowtype;
  v_profile public.profiles%rowtype;
  v_template_id uuid;
  v_template_name text;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if p_schedule_id is null then
    raise exception 'Schedule entry is required.';
  end if;

  select schedule.* into v_schedule
  from public.work_schedules schedule
  where schedule.id = p_schedule_id
  for update;

  if not found then
    raise exception 'Schedule entry not found.';
  end if;

  if not public.workforce_can_manage_user(v_schedule.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee schedule.';
  end if;

  select profile.* into v_profile
  from public.profiles profile
  where profile.user_id = v_schedule.user_id;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_profile.is_agent is not true
     or v_profile.base_role <> 'agent'
     or v_profile.employment_status <> 'active' then
    raise exception 'Weekly repetition can only be enabled for active normal agents.';
  end if;

  if v_schedule.status not in ('scheduled', 'published', 'changed') then
    raise exception 'Only draft or published schedule entries can repeat weekly.';
  end if;

  if v_schedule.is_holiday then
    raise exception 'Holiday entries cannot repeat weekly. Add holidays manually.';
  end if;

  v_template_name := 'User weekly schedule - ' || v_schedule.user_id::text;

  insert into public.work_schedule_templates (
    name, timezone, is_active, created_by, updated_by
  ) values (
    v_template_name, v_schedule.timezone, true, v_actor, v_actor
  )
  on conflict ((lower(name))) do update
  set timezone = excluded.timezone,
      is_active = true,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning id into v_template_id;

  insert into public.work_schedule_template_days (
    template_id, weekday, shift_sequence, start_time, end_time,
    end_day_offset, is_rest_day
  ) values (
    v_template_id,
    extract(dow from v_schedule.shift_date)::smallint,
    v_schedule.shift_sequence,
    case when v_schedule.is_rest_day then null
         else (v_schedule.shift_start at time zone v_schedule.timezone)::time end,
    case when v_schedule.is_rest_day then null
         else (v_schedule.shift_end at time zone v_schedule.timezone)::time end,
    case when v_schedule.is_rest_day then 0
         else ((v_schedule.shift_end at time zone v_schedule.timezone)::date
             - (v_schedule.shift_start at time zone v_schedule.timezone)::date)::smallint end,
    v_schedule.is_rest_day
  )
  on conflict (template_id, weekday, shift_sequence) do update
  set start_time = excluded.start_time,
      end_time = excluded.end_time,
      end_day_offset = excluded.end_day_offset,
      is_rest_day = excluded.is_rest_day,
      updated_at = now();

  update public.work_schedule_template_assignments
  set is_active = false,
      updated_at = now()
  where user_id = v_schedule.user_id
    and is_active
    and template_id <> v_template_id;

  insert into public.work_schedule_template_assignments (
    template_id, user_id, team_id, is_active, effective_from,
    effective_until, allow_admin_agent, created_by
  ) values (
    v_template_id, v_schedule.user_id, null, true, v_schedule.shift_date,
    null, false, v_actor
  )
  on conflict (user_id) where user_id is not null and is_active do update
  set template_id = excluded.template_id,
      effective_from = least(public.work_schedule_template_assignments.effective_from, excluded.effective_from),
      effective_until = null,
      allow_admin_agent = false,
      updated_at = now();

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, after_data, reason
  ) values (
    v_actor,
    'weekly_schedule_template_entry_saved',
    'work_schedule_template',
    v_template_id,
    jsonb_build_object(
      'schedule_id', v_schedule.id,
      'employee_user_id', v_schedule.user_id,
      'weekday', extract(dow from v_schedule.shift_date)::integer,
      'shift_sequence', v_schedule.shift_sequence,
      'is_rest_day', v_schedule.is_rest_day
    ),
    'Admin added a saved schedule entry to Sunday weekly automation'
  );

  return v_template_id;
end;
$$;

create or replace function public.workforce_admin_save_schedule_and_repeat(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_shift_start timestamptz,
  p_shift_end timestamptz,
  p_timezone text,
  p_status text,
  p_is_rest_day boolean,
  p_is_holiday boolean,
  p_holiday_name text,
  p_notes text,
  p_repeat_weekly boolean default false
)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result public.work_schedules%rowtype;
begin
  v_result := public.workforce_admin_save_schedule(
    p_schedule_id, p_user_id, p_shift_date, p_shift_sequence,
    p_shift_start, p_shift_end, p_timezone, p_status, p_is_rest_day,
    p_is_holiday, p_holiday_name, p_notes
  );

  if coalesce(p_repeat_weekly, false) then
    perform public.workforce_admin_add_schedule_to_weekly_template(v_result.id);
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_admin_add_schedule_to_weekly_template(uuid)
  from public, anon, authenticated;
revoke all on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) from public, anon;
grant execute on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) to authenticated;

comment on function public.workforce_admin_add_schedule_to_weekly_template(uuid) is
  'Adds or updates one saved schedule entry in an employee recurring template.';
comment on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) is 'Saves schedule entries and optionally adds each checked entry to Sunday weekly automation.';

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
) values (
  'recurring_schedule_checkbox_simplified',
  'work_schedule_template',
  jsonb_build_object(
    'incremental_template_entries', true,
    'complete_week_required', false,
    'multi_date_selection_supported', true
  ),
  'Simplified weekly automation enrollment to one checkbox per saved schedule entry'
);

commit;
