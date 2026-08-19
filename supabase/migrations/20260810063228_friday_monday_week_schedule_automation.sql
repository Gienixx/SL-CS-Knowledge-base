-- Run weekly schedule automation on Friday for the upcoming Monday-Sunday week.
-- Existing template weekdays remain Sunday=0 through Saturday=6; the generator
-- maps them into the Monday-based target range without overwriting schedule rows.

begin;

create or replace function public.workforce_generate_weekly_schedules(
  p_week_start date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_today date := (now() at time zone 'America/New_York')::date;
  v_week_start date;
  v_assignment record;
  v_day record;
  v_shift_date date;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_leave_approved boolean;
  v_inserted integer := 0;
begin
  v_week_start := coalesce(
    p_week_start,
    v_local_today + (8 - extract(isodow from v_local_today)::integer)
  );

  if extract(isodow from v_week_start)::integer <> 1 then
    raise exception 'Weekly schedule generation must start on a Monday.';
  end if;

  for v_assignment in
    select distinct on (profile.user_id)
      profile.user_id,
      profile.team_id,
      assignment.template_id,
      template.timezone
    from public.work_schedule_template_assignments assignment
    join public.work_schedule_templates template
      on template.id = assignment.template_id
     and template.is_active
    join public.profiles profile
      on profile.user_id = assignment.user_id
      or (assignment.user_id is null and profile.team_id = assignment.team_id)
    where assignment.is_active
      and profile.employment_status = 'active'
      and profile.is_agent is true
      and (profile.base_role = 'agent' or assignment.allow_admin_agent)
      and assignment.effective_from <= v_week_start + 6
      and (assignment.effective_until is null or assignment.effective_until >= v_week_start)
    order by profile.user_id, (assignment.user_id is not null) desc, assignment.created_at desc
  loop
    for v_day in
      select template_day.*
      from public.work_schedule_template_days template_day
      where template_day.template_id = v_assignment.template_id
      order by template_day.weekday, template_day.shift_sequence
    loop
      -- Template weekday 0 is Sunday. Monday-based weeks therefore place
      -- Sunday on offset 6 and Monday on offset 0.
      v_shift_date := v_week_start + ((v_day.weekday + 6) % 7);
      v_leave_approved := exists (
        select 1
        from public.leave_requests leave_request
        where leave_request.user_id = v_assignment.user_id
          and leave_request.status = 'approved'
          and v_shift_date between leave_request.start_date and leave_request.end_date
      );

      if v_day.is_rest_day then
        v_shift_start := null;
        v_shift_end := null;
      else
        v_shift_start := make_timestamptz(
          extract(year from v_shift_date)::integer,
          extract(month from v_shift_date)::integer,
          extract(day from v_shift_date)::integer,
          extract(hour from v_day.start_time)::integer,
          extract(minute from v_day.start_time)::integer,
          0,
          v_assignment.timezone
        );
        v_shift_end := make_timestamptz(
          extract(year from v_shift_date + v_day.end_day_offset)::integer,
          extract(month from v_shift_date + v_day.end_day_offset)::integer,
          extract(day from v_shift_date + v_day.end_day_offset)::integer,
          extract(hour from v_day.end_time)::integer,
          extract(minute from v_day.end_time)::integer,
          0,
          v_assignment.timezone
        );
      end if;

      insert into public.work_schedules (
        user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
        timezone, status, is_rest_day, is_holiday, holiday_name, notes,
        schedule_template_id, generated_by_automation, admin_override,
        automation_leave_cancelled
      ) values (
        v_assignment.user_id, v_assignment.team_id, v_shift_date,
        v_day.shift_sequence, v_shift_start, v_shift_end, v_assignment.timezone,
        case when v_leave_approved and not v_day.is_rest_day then 'cancelled' else 'published' end,
        v_day.is_rest_day, false, null, 'Generated from weekly schedule template',
        v_assignment.template_id, true, false,
        v_leave_approved and not v_day.is_rest_day
      )
      on conflict (user_id, shift_date, shift_sequence) do nothing;

      if found then
        v_inserted := v_inserted + 1;
      end if;
    end loop;
  end loop;

  return v_inserted;
end;
$$;

create or replace function public.workforce_run_weekly_schedule_cron()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_now timestamp := now() at time zone 'America/New_York';
begin
  -- pg_cron invokes this hourly; Friday at 06:00 local time is the trigger.
  if extract(isodow from v_local_now)::integer <> 5
     or extract(hour from v_local_now)::integer <> 6 then
    return 0;
  end if;

  return public.workforce_generate_weekly_schedules();
end;
$$;

revoke all on function public.workforce_generate_weekly_schedules(date) from public, anon, authenticated;
revoke all on function public.workforce_run_weekly_schedule_cron() from public, anon, authenticated;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'workforce-weekly-schedule-generator';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'workforce-weekly-schedule-generator',
    '0 * * * 5',
    'select public.workforce_run_weekly_schedule_cron();'
  );
end;
$$;

commit;
