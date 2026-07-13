-- Weekly schedule automation. The initial assignment is intentionally limited
-- to arby@eurekasurveys.com for production testing. The assignment model also
-- supports team scope when the rollout is approved.

begin;

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.work_schedule_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/New_York',
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_schedule_templates_name_not_blank check (length(trim(name)) > 0),
  constraint work_schedule_templates_timezone_not_blank check (length(trim(timezone)) > 0)
);

create unique index if not exists work_schedule_templates_name_lower_unique
  on public.work_schedule_templates (lower(name));

create table if not exists public.work_schedule_template_days (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.work_schedule_templates(id) on delete cascade,
  weekday smallint not null,
  shift_sequence smallint not null default 1,
  start_time time,
  end_time time,
  end_day_offset smallint not null default 0,
  is_rest_day boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_schedule_template_days_weekday_check check (weekday between 0 and 6),
  constraint work_schedule_template_days_sequence_check check (shift_sequence between 1 and 99),
  constraint work_schedule_template_days_offset_check check (end_day_offset in (0, 1)),
  constraint work_schedule_template_days_time_check check (
    (is_rest_day and start_time is null and end_time is null and end_day_offset = 0)
    or
    (
      not is_rest_day
      and start_time is not null
      and end_time is not null
      and (end_day_offset = 1 or end_time > start_time)
    )
  ),
  unique (template_id, weekday, shift_sequence)
);

create index if not exists work_schedule_template_days_template_idx
  on public.work_schedule_template_days (template_id, weekday);

create table if not exists public.work_schedule_template_assignments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.work_schedule_templates(id) on delete cascade,
  user_id uuid references public.profiles(user_id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  is_active boolean not null default true,
  effective_from date not null,
  effective_until date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_schedule_template_assignments_scope_check check (
    (user_id is not null and team_id is null)
    or (user_id is null and team_id is not null)
  ),
  constraint work_schedule_template_assignments_dates_check check (
    effective_until is null or effective_until >= effective_from
  )
);

create unique index if not exists work_schedule_template_assignments_user_unique
  on public.work_schedule_template_assignments (user_id)
  where user_id is not null and is_active;

create unique index if not exists work_schedule_template_assignments_team_unique
  on public.work_schedule_template_assignments (team_id)
  where team_id is not null and is_active;

create index if not exists work_schedule_template_assignments_template_idx
  on public.work_schedule_template_assignments (template_id);

alter table public.work_schedules
  add column if not exists schedule_template_id uuid
    references public.work_schedule_templates(id) on delete set null,
  add column if not exists generated_by_automation boolean not null default false,
  add column if not exists admin_override boolean not null default false,
  add column if not exists automation_leave_cancelled boolean not null default false;

create index if not exists work_schedules_template_date_idx
  on public.work_schedules (schedule_template_id, shift_date)
  where generated_by_automation;

alter table public.work_schedule_templates enable row level security;
alter table public.work_schedule_template_days enable row level security;
alter table public.work_schedule_template_assignments enable row level security;

revoke all on public.work_schedule_templates from public, anon, authenticated;
revoke all on public.work_schedule_template_days from public, anon, authenticated;
revoke all on public.work_schedule_template_assignments from public, anon, authenticated;

create or replace function public.workforce_mark_generated_schedule_override()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.generated_by_automation
     and pg_trigger_depth() = 1
     and auth.uid() is not null
     and (
       new.shift_date is distinct from old.shift_date
       or new.shift_sequence is distinct from old.shift_sequence
       or new.shift_start is distinct from old.shift_start
       or new.shift_end is distinct from old.shift_end
       or new.timezone is distinct from old.timezone
       or new.status is distinct from old.status
       or new.is_rest_day is distinct from old.is_rest_day
       or new.is_holiday is distinct from old.is_holiday
       or new.holiday_name is distinct from old.holiday_name
     ) then
    new.admin_override := true;
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedules_mark_generated_override on public.work_schedules;
create trigger work_schedules_mark_generated_override
before update on public.work_schedules
for each row execute function public.workforce_mark_generated_schedule_override();

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
      and profile.base_role = 'agent'
      and profile.is_agent is true
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

create or replace function public.workforce_sync_approved_leave_schedules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'approved' then
    update public.work_schedules schedule
    set status = 'published',
        automation_leave_cancelled = false,
        updated_at = now()
    where schedule.user_id = old.user_id
      and schedule.shift_date between old.start_date and old.end_date
      and schedule.generated_by_automation
      and schedule.automation_leave_cancelled
      and not schedule.admin_override;
  end if;

  if new.status = 'approved' then
    update public.work_schedules schedule
    set status = 'cancelled',
        automation_leave_cancelled = true,
        updated_at = now()
    where schedule.user_id = new.user_id
      and schedule.shift_date between new.start_date and new.end_date
      and schedule.generated_by_automation
      and not schedule.admin_override
      and not schedule.is_rest_day
      and schedule.status in ('scheduled', 'published', 'changed');
  end if;

  return new;
end;
$$;

drop trigger if exists leave_requests_sync_generated_schedules on public.leave_requests;
create trigger leave_requests_sync_generated_schedules
after insert or update of status, start_date, end_date on public.leave_requests
for each row execute function public.workforce_sync_approved_leave_schedules();

create or replace function public.workforce_run_weekly_schedule_cron()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_now timestamp := now() at time zone 'America/New_York';
begin
  if extract(dow from v_local_now)::integer <> 0
     or extract(hour from v_local_now)::integer <> 6 then
    return 0;
  end if;

  return public.workforce_generate_weekly_schedules(v_local_now::date);
end;
$$;

revoke all on function public.workforce_generate_weekly_schedules(date) from public, anon, authenticated;
revoke all on function public.workforce_run_weekly_schedule_cron() from public, anon, authenticated;
revoke all on function public.workforce_sync_approved_leave_schedules() from public, anon, authenticated;
revoke all on function public.workforce_mark_generated_schedule_override() from public, anon, authenticated;

do $$
declare
  v_template_id uuid;
  v_user_id uuid;
begin
  insert into public.work_schedule_templates (name, timezone, is_active)
  values ('Arby weekly schedule test', 'America/New_York', true)
  on conflict ((lower(name))) do update
  set timezone = excluded.timezone,
      is_active = true,
      updated_at = now()
  returning id into v_template_id;

  insert into public.work_schedule_template_days (
    template_id, weekday, shift_sequence, start_time, end_time, end_day_offset, is_rest_day
  ) values
    (v_template_id, 0, 1, null, null, 0, true),
    (v_template_id, 1, 1, null, null, 0, true),
    (v_template_id, 2, 1, time '10:00', time '18:00', 0, false),
    (v_template_id, 3, 1, time '10:00', time '18:00', 0, false),
    (v_template_id, 4, 1, time '10:00', time '18:00', 0, false),
    (v_template_id, 5, 1, time '10:00', time '18:00', 0, false),
    (v_template_id, 6, 1, time '06:00', time '14:00', 0, false)
  on conflict (template_id, weekday, shift_sequence) do update
  set start_time = excluded.start_time,
      end_time = excluded.end_time,
      end_day_offset = excluded.end_day_offset,
      is_rest_day = excluded.is_rest_day,
      updated_at = now();

  select profile.user_id
  into v_user_id
  from public.profiles profile
  where lower(profile.email) = 'arby@eurekasurveys.com';

  if v_user_id is not null then
    insert into public.work_schedule_template_assignments (
      template_id, user_id, team_id, is_active, effective_from
    ) values (
      v_template_id,
      v_user_id,
      null,
      true,
      (now() at time zone 'America/New_York')::date
    )
    on conflict (user_id) where user_id is not null and is_active do update
    set template_id = excluded.template_id,
        effective_from = excluded.effective_from,
        updated_at = now();
  end if;
end;
$$;

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
    '0 * * * 0',
    'select public.workforce_run_weekly_schedule_cron();'
  );
end;
$$;

select public.workforce_generate_weekly_schedules();

commit;
