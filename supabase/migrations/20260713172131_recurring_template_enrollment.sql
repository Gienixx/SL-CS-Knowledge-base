-- Allow an authorized schedule manager to turn one complete Sunday-Saturday
-- schedule into a recurring, per-user automation template.

begin;

create or replace function public.workforce_admin_enroll_weekly_template(
  p_user_id uuid,
  p_week_start date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_template_id uuid;
  v_template_name text := 'User weekly schedule - ' || p_user_id::text;
  v_schedule_count integer;
  v_date_count integer;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if p_user_id is null or p_week_start is null then
    raise exception 'Employee and week start are required.';
  end if;

  if extract(dow from p_week_start)::integer <> 0 then
    raise exception 'The recurring schedule week must start on Sunday.';
  end if;

  if not public.workforce_can_manage_user(p_user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee schedule.';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_profile.is_agent is not true
     or v_profile.base_role <> 'agent'
     or v_profile.employment_status <> 'active' then
    raise exception 'Weekly repetition can only be enabled for active normal agents.';
  end if;

  select count(*), count(distinct schedule.shift_date)
  into v_schedule_count, v_date_count
  from public.work_schedules schedule
  where schedule.user_id = p_user_id
    and schedule.shift_date between p_week_start and p_week_start + 6
    and schedule.status in ('scheduled', 'published', 'changed');

  if v_schedule_count <> 7 or v_date_count <> 7 or exists (
    select 1
    from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date between p_week_start and p_week_start + 6
      and schedule.status in ('scheduled', 'published', 'changed')
      and schedule.shift_sequence <> 1
  ) then
    raise exception 'Complete Sunday through Saturday with exactly one shift or rest-day entry per date before enabling weekly repetition.';
  end if;

  if exists (
    select 1
    from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date between p_week_start and p_week_start + 6
      and schedule.status in ('scheduled', 'published', 'changed')
      and schedule.is_holiday
  ) then
    raise exception 'Holiday entries cannot be copied into a recurring weekly schedule. Add holidays manually.';
  end if;

  insert into public.work_schedule_templates (
    name, timezone, is_active, created_by, updated_by
  ) values (
    v_template_name, 'America/New_York', true, v_actor, v_actor
  )
  on conflict ((lower(name))) do update
  set timezone = 'America/New_York',
      is_active = true,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning id into v_template_id;

  delete from public.work_schedule_template_days
  where template_id = v_template_id;

  insert into public.work_schedule_template_days (
    template_id, weekday, shift_sequence, start_time, end_time,
    end_day_offset, is_rest_day
  )
  select
    v_template_id,
    extract(dow from schedule.shift_date)::smallint,
    1,
    case when schedule.is_rest_day then null
         else (schedule.shift_start at time zone 'America/New_York')::time end,
    case when schedule.is_rest_day then null
         else (schedule.shift_end at time zone 'America/New_York')::time end,
    case when schedule.is_rest_day then 0
         else ((schedule.shift_end at time zone 'America/New_York')::date
             - (schedule.shift_start at time zone 'America/New_York')::date)::smallint end,
    schedule.is_rest_day
  from public.work_schedules schedule
  where schedule.user_id = p_user_id
    and schedule.shift_date between p_week_start and p_week_start + 6
    and schedule.status in ('scheduled', 'published', 'changed')
  order by schedule.shift_date;

  update public.work_schedule_template_assignments
  set is_active = false,
      updated_at = now()
  where user_id = p_user_id
    and is_active
    and template_id <> v_template_id;

  insert into public.work_schedule_template_assignments (
    template_id, user_id, team_id, is_active, effective_from,
    effective_until, allow_admin_agent, created_by
  ) values (
    v_template_id, p_user_id, null, true, p_week_start,
    null, false, v_actor
  )
  on conflict (user_id) where user_id is not null and is_active do update
  set template_id = excluded.template_id,
      effective_from = excluded.effective_from,
      effective_until = null,
      allow_admin_agent = false,
      updated_at = now();

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
set search_path = public, pg_temp
as $$
declare
  v_result public.work_schedules%rowtype;
  v_week_start date;
begin
  v_result := public.workforce_admin_save_schedule(
    p_schedule_id, p_user_id, p_shift_date, p_shift_sequence,
    p_shift_start, p_shift_end, p_timezone, p_status, p_is_rest_day,
    p_is_holiday, p_holiday_name, p_notes
  );

  if coalesce(p_repeat_weekly, false) then
    v_week_start := p_shift_date - extract(dow from p_shift_date)::integer;
    perform public.workforce_admin_enroll_weekly_template(p_user_id, v_week_start);
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_admin_enroll_weekly_template(uuid, date)
  from public, anon, authenticated;
revoke all on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) from public, anon;
grant execute on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) to authenticated;

comment on function public.workforce_admin_save_schedule_and_repeat(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text, boolean
) is 'Atomically saves a schedule row and optionally captures its complete Sunday-Saturday week as the user recurring template.';

commit;
