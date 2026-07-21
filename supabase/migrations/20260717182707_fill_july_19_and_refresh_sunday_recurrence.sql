-- Fill missing July 19 schedules from July 12 and make Sunday recurrence
-- match July 12 without overwriting any schedule already created by an admin.

begin;

create temporary table sunday_source on commit drop as
select
  schedule.*,
  case when schedule.is_rest_day then null
       else (schedule.shift_start at time zone schedule.timezone)::time end as local_start_time,
  case when schedule.is_rest_day then null
       else (schedule.shift_end at time zone schedule.timezone)::time end as local_end_time,
  case when schedule.is_rest_day then 0
       else ((schedule.shift_end at time zone schedule.timezone)::date
           - (schedule.shift_start at time zone schedule.timezone)::date)::smallint end as end_day_offset
from public.work_schedules schedule
where schedule.shift_date = date '2026-07-12'
  and schedule.status in ('scheduled', 'published', 'changed', 'completed');

do $$
declare
  v_users integer;
  v_entries integer;
  v_missing integer;
begin
  select count(distinct user_id), count(*)
  into v_users, v_entries
  from sunday_source;

  select count(*) into v_missing
  from sunday_source source
  left join public.work_schedules target
    on target.user_id = source.user_id
   and target.shift_date = date '2026-07-19'
   and target.shift_sequence = source.shift_sequence
  where target.id is null;

  if v_users <> 9 or v_entries <> 9 or v_missing <> 6 then
    raise exception 'Sunday source changed: expected 9 users, 9 entries and 6 missing July 19 rows; found %, % and %.',
      v_users, v_entries, v_missing;
  end if;
end;
$$;

insert into public.work_schedules (
  user_id, team_id, shift_date, shift_sequence,
  shift_start, shift_end, timezone, status,
  is_rest_day, is_holiday, holiday_name, notes,
  created_by, updated_by, schedule_template_id,
  generated_by_automation, admin_override, automation_leave_cancelled
)
select
  source.user_id,
  source.team_id,
  date '2026-07-19',
  source.shift_sequence,
  case when source.is_rest_day then null else make_timestamptz(
    2026, 7, 19,
    extract(hour from source.local_start_time)::integer,
    extract(minute from source.local_start_time)::integer,
    0,
    source.timezone
  ) end,
  case when source.is_rest_day then null else make_timestamptz(
    2026, 7, 19 + source.end_day_offset,
    extract(hour from source.local_end_time)::integer,
    extract(minute from source.local_end_time)::integer,
    0,
    source.timezone
  ) end,
  source.timezone,
  'published',
  source.is_rest_day,
  false,
  null,
  'Copied from July 12 Sunday schedule',
  source.created_by,
  source.updated_by,
  null,
  false,
  true,
  false
from sunday_source source
on conflict (user_id, shift_date, shift_sequence) do nothing;

delete from public.work_schedule_template_days template_day
using public.work_schedule_templates template,
      (select distinct user_id from sunday_source) source_user
where template_day.template_id = template.id
  and template_day.weekday = 0
  and lower(template.name) = lower('User weekly schedule - ' || source_user.user_id::text);

insert into public.work_schedule_template_days (
  template_id, weekday, shift_sequence, start_time, end_time,
  end_day_offset, is_rest_day
)
select
  template.id,
  0,
  source.shift_sequence,
  source.local_start_time,
  source.local_end_time,
  source.end_day_offset,
  source.is_rest_day
from sunday_source source
join public.work_schedule_templates template
  on lower(template.name) = lower('User weekly schedule - ' || source.user_id::text);

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
values (
  'july_19_schedules_filled',
  'work_schedule',
  jsonb_build_object(
    'source_date', '2026-07-12',
    'target_date', '2026-07-19',
    'source_users', 9,
    'inserted_missing_entries', 6,
    'sunday_templates_refreshed', 9,
    'existing_target_schedules', 'preserved'
  ),
  'Filled missing July 19 schedules from July 12 and refreshed Sunday recurrence without overwriting existing schedules'
);

commit;
