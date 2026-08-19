-- Add individual weekly templates for Jean, Ford, Gen, Arez, and Almar.
-- Almar is the only assignment explicitly permitted to generate while the
-- profile has an admin base role; all assignments still require is_agent=true.

begin;

alter table public.work_schedule_template_assignments
  add column if not exists allow_admin_agent boolean not null default false;

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
    v_local_today - extract(dow from v_local_today)::integer
  );

  if extract(dow from v_week_start)::integer <> 0 then
    raise exception 'Weekly schedule generation must start on a Sunday.';
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
      v_shift_date := v_week_start + v_day.weekday;
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
        user_id,
        team_id,
        shift_date,
        shift_sequence,
        shift_start,
        shift_end,
        timezone,
        status,
        is_rest_day,
        is_holiday,
        holiday_name,
        notes,
        schedule_template_id,
        generated_by_automation,
        admin_override,
        automation_leave_cancelled
      ) values (
        v_assignment.user_id,
        v_assignment.team_id,
        v_shift_date,
        v_day.shift_sequence,
        v_shift_start,
        v_shift_end,
        v_assignment.timezone,
        case when v_leave_approved and not v_day.is_rest_day then 'cancelled' else 'published' end,
        v_day.is_rest_day,
        false,
        null,
        'Generated from weekly schedule template',
        v_assignment.template_id,
        true,
        false,
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

revoke all on function public.workforce_generate_weekly_schedules(date)
  from public, anon, authenticated;

do $$
declare
  v_config record;
  v_day record;
  v_template_id uuid;
  v_user_id uuid;
begin
  for v_config in
    select *
    from jsonb_to_recordset(
      $config$[
        {
          "email": "jean@eurekasurveys.com",
          "name": "Jean weekly schedule",
          "allow_admin": false,
          "days": [
            {"weekday":0,"start":"11:00","end":"19:00","rest":false},
            {"weekday":1,"start":"11:00","end":"19:00","rest":false},
            {"weekday":2,"start":"11:00","end":"19:00","rest":false},
            {"weekday":3,"start":"11:00","end":"19:00","rest":false},
            {"weekday":4,"start":"11:00","end":"19:00","rest":false},
            {"weekday":5,"rest":true},
            {"weekday":6,"rest":true}
          ]
        },
        {
          "email": "ford@eurekasurveys.com",
          "name": "Ford weekly schedule",
          "allow_admin": false,
          "days": [
            {"weekday":0,"rest":true},
            {"weekday":1,"start":"08:00","end":"16:00","rest":false},
            {"weekday":2,"start":"08:00","end":"16:00","rest":false},
            {"weekday":3,"start":"08:00","end":"16:00","rest":false},
            {"weekday":4,"start":"08:00","end":"16:00","rest":false},
            {"weekday":5,"start":"08:00","end":"16:00","rest":false},
            {"weekday":6,"rest":true}
          ]
        },
        {
          "email": "gen@eurekasurveys.com",
          "name": "Gen weekly schedule",
          "allow_admin": false,
          "days": [
            {"weekday":0,"start":"08:00","end":"16:00","rest":false},
            {"weekday":1,"rest":true},
            {"weekday":2,"rest":true},
            {"weekday":3,"start":"08:00","end":"16:00","rest":false},
            {"weekday":4,"start":"08:00","end":"16:00","rest":false},
            {"weekday":5,"start":"08:00","end":"16:00","rest":false},
            {"weekday":6,"start":"08:00","end":"16:00","rest":false}
          ]
        },
        {
          "email": "arez@eurekasurveys.com",
          "name": "Arez weekly schedule",
          "allow_admin": false,
          "days": [
            {"weekday":0,"start":"10:00","end":"18:00","rest":false},
            {"weekday":1,"rest":true},
            {"weekday":2,"rest":true},
            {"weekday":3,"start":"10:00","end":"18:00","rest":false},
            {"weekday":4,"start":"10:00","end":"18:00","rest":false},
            {"weekday":5,"start":"10:00","end":"18:00","rest":false},
            {"weekday":6,"start":"10:00","end":"18:00","rest":false}
          ]
        },
        {
          "email": "almar@eurekasurveys.com",
          "name": "Almar weekly schedule",
          "allow_admin": true,
          "days": [
            {"weekday":0,"rest":true},
            {"weekday":1,"start":"06:00","end":"18:00","rest":false},
            {"weekday":2,"start":"06:00","end":"18:00","rest":false},
            {"weekday":3,"start":"06:00","end":"18:00","rest":false},
            {"weekday":4,"start":"06:00","end":"18:00","rest":false},
            {"weekday":5,"start":"06:00","end":"18:00","rest":false},
            {"weekday":6,"rest":true}
          ]
        }
      ]$config$::jsonb
    ) as config(email text, name text, allow_admin boolean, days jsonb)
  loop
    insert into public.work_schedule_templates (name, timezone, is_active)
    values (v_config.name, 'America/New_York', true)
    on conflict ((lower(name))) do update
    set timezone = excluded.timezone,
        is_active = true,
        updated_at = now()
    returning id into v_template_id;

    for v_day in
      select *
      from jsonb_to_recordset(v_config.days)
        as template_day(weekday smallint, start text, "end" text, rest boolean)
    loop
      insert into public.work_schedule_template_days (
        template_id, weekday, shift_sequence, start_time, end_time, end_day_offset, is_rest_day
      ) values (
        v_template_id,
        v_day.weekday,
        1,
        case when v_day.rest then null else v_day.start::time end,
        case when v_day.rest then null else v_day."end"::time end,
        0,
        v_day.rest
      )
      on conflict (template_id, weekday, shift_sequence) do update
      set start_time = excluded.start_time,
          end_time = excluded.end_time,
          end_day_offset = excluded.end_day_offset,
          is_rest_day = excluded.is_rest_day,
          updated_at = now();
    end loop;

    select profile.user_id
    into v_user_id
    from public.profiles profile
    where lower(profile.email) = lower(v_config.email);

    if v_user_id is not null then
      insert into public.work_schedule_template_assignments (
        template_id,
        user_id,
        team_id,
        is_active,
        effective_from,
        allow_admin_agent
      ) values (
        v_template_id,
        v_user_id,
        null,
        true,
        (now() at time zone 'America/New_York')::date,
        v_config.allow_admin
      )
      on conflict (user_id) where user_id is not null and is_active do update
      set template_id = excluded.template_id,
          effective_from = excluded.effective_from,
          allow_admin_agent = excluded.allow_admin_agent,
          updated_at = now();
    end if;
  end loop;
end;
$$;

select public.workforce_generate_weekly_schedules();

commit;
