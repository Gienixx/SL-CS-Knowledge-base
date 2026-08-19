-- Replace the incomplete July 13-19 copy with the complete July 6-12 pattern.
-- Existing admin-created schedules are preserved. Arby's pattern keeps only
-- 10:00-18:00 work shifts as sequence 1, plus his recorded rest days.

begin;

create temporary table schedule_pattern_source on commit drop as
select
  schedule.*,
  extract(dow from schedule.shift_date)::smallint as weekday,
  case when schedule.user_id = 'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid
       then 1 else schedule.shift_sequence end as pattern_sequence,
  case when schedule.is_rest_day then null
       else (schedule.shift_start at time zone schedule.timezone)::time end as local_start_time,
  case when schedule.is_rest_day then null
       else (schedule.shift_end at time zone schedule.timezone)::time end as local_end_time,
  case when schedule.is_rest_day then 0
       else ((schedule.shift_end at time zone schedule.timezone)::date
           - (schedule.shift_start at time zone schedule.timezone)::date)::smallint end as end_day_offset
from public.work_schedules schedule
where schedule.shift_date between date '2026-07-06' and date '2026-07-12'
  and schedule.status in ('scheduled', 'published', 'changed', 'completed')
  and (
    schedule.user_id <> 'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid
    or schedule.is_rest_day
    or (
      (schedule.shift_start at time zone schedule.timezone)::time = time '10:00'
      and (schedule.shift_end at time zone schedule.timezone)::time = time '18:00'
    )
  );

do $$
declare
  v_users integer;
  v_entries integer;
  v_sundays integer;
begin
  select count(distinct user_id), count(*),
         count(*) filter (where weekday = 0)
  into v_users, v_entries, v_sundays
  from schedule_pattern_source;

  if v_users <> 9 or v_entries <> 62 or v_sundays <> 9 then
    raise exception 'July 6-12 source changed: expected 9 users, 62 selected entries and 9 Sundays; found %, % and %.',
      v_users, v_entries, v_sundays;
  end if;
end;
$$;

-- Remove only rows created by the previous copy. Never remove admin-created rows.
delete from public.work_schedules
where shift_date between date '2026-07-20' and date '2026-07-31'
  and notes = 'Copied from July 13-19 schedule pattern';

with target_dates as (
  select generate_series(date '2026-07-20', date '2026-07-31', interval '1 day')::date as shift_date
), desired as (
  select source.*, target.shift_date as target_date
  from schedule_pattern_source source
  join target_dates target
    on extract(dow from target.shift_date)::smallint = source.weekday
)
insert into public.work_schedules (
  user_id, team_id, shift_date, shift_sequence,
  shift_start, shift_end, timezone, status,
  is_rest_day, is_holiday, holiday_name, notes,
  created_by, updated_by, schedule_template_id,
  generated_by_automation, admin_override, automation_leave_cancelled
)
select
  desired.user_id,
  desired.team_id,
  desired.target_date,
  desired.pattern_sequence,
  case when desired.is_rest_day then null else make_timestamptz(
    extract(year from desired.target_date)::integer,
    extract(month from desired.target_date)::integer,
    extract(day from desired.target_date)::integer,
    extract(hour from desired.local_start_time)::integer,
    extract(minute from desired.local_start_time)::integer,
    0,
    desired.timezone
  ) end,
  case when desired.is_rest_day then null else make_timestamptz(
    extract(year from desired.target_date + desired.end_day_offset)::integer,
    extract(month from desired.target_date + desired.end_day_offset)::integer,
    extract(day from desired.target_date + desired.end_day_offset)::integer,
    extract(hour from desired.local_end_time)::integer,
    extract(minute from desired.local_end_time)::integer,
    0,
    desired.timezone
  ) end,
  desired.timezone,
  'published',
  desired.is_rest_day,
  false,
  null,
  'Copied from July 6-12 schedule pattern',
  desired.created_by,
  desired.updated_by,
  null,
  false,
  true,
  false
from desired
on conflict (user_id, shift_date, shift_sequence) do nothing;

-- Replace the August automation template days with this corrected pattern.
delete from public.work_schedule_template_days template_day
using public.work_schedule_templates template,
      (select distinct user_id from schedule_pattern_source) source_user
where template_day.template_id = template.id
  and lower(template.name) = lower('User weekly schedule - ' || source_user.user_id::text);

insert into public.work_schedule_template_days (
  template_id, weekday, shift_sequence, start_time, end_time,
  end_day_offset, is_rest_day
)
select
  template.id,
  source.weekday,
  source.pattern_sequence,
  source.local_start_time,
  source.local_end_time,
  source.end_day_offset,
  source.is_rest_day
from schedule_pattern_source source
join public.work_schedule_templates template
  on lower(template.name) = lower('User weekly schedule - ' || source.user_id::text)
on conflict (template_id, weekday, shift_sequence) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    end_day_offset = excluded.end_day_offset,
    is_rest_day = excluded.is_rest_day,
    updated_at = now();

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
values (
  'july_schedule_pattern_replaced',
  'work_schedule',
  jsonb_build_object(
    'source_range', jsonb_build_array('2026-07-06', '2026-07-12'),
    'target_range', jsonb_build_array('2026-07-20', '2026-07-31'),
    'source_users', 9,
    'selected_source_entries', 62,
    'sunday_entries', 9,
    'arby_rule', 'Only 10:00-18:00 work shifts as sequence 1; recorded rest days retained',
    'existing_admin_schedules', 'preserved',
    'templates_effective_from', '2026-08-01'
  ),
  'Replaced incomplete copied pattern with July 6-12 and retained admin-created schedule conflicts'
);

commit;
