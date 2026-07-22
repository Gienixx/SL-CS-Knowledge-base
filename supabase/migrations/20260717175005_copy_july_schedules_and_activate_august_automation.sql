-- Copy the July 13-19 pattern through July 31 without replacing any existing
-- schedule slot, then activate matching per-user templates for August.

begin;

create temporary table schedule_copy_source on commit drop as
select
  schedule.*,
  extract(dow from schedule.shift_date)::smallint as weekday,
  case when schedule.is_rest_day then null
       else (schedule.shift_start at time zone schedule.timezone)::time end as local_start_time,
  case when schedule.is_rest_day then null
       else (schedule.shift_end at time zone schedule.timezone)::time end as local_end_time,
  case when schedule.is_rest_day then 0
       else ((schedule.shift_end at time zone schedule.timezone)::date
           - (schedule.shift_start at time zone schedule.timezone)::date)::smallint end as end_day_offset
from public.work_schedules schedule
where schedule.shift_date between date '2026-07-13' and date '2026-07-19'
  and schedule.status in ('scheduled', 'published', 'changed', 'completed');

do $$
declare
  v_users integer;
  v_entries integer;
begin
  select count(distinct user_id), count(*)
  into v_users, v_entries
  from schedule_copy_source;

  if v_users <> 9 or v_entries <> 57 then
    raise exception 'Source week changed: expected 9 users and 57 entries, found % users and % entries.',
      v_users, v_entries;
  end if;
end;
$$;

create temporary table schedule_copy_existing on commit drop as
select schedule.id, schedule.user_id, schedule.shift_date, schedule.shift_sequence,
       schedule.generated_by_automation, schedule.admin_override
from public.work_schedules schedule
join schedule_copy_source source
  on source.user_id = schedule.user_id
 and source.shift_sequence = schedule.shift_sequence
 and extract(dow from schedule.shift_date)::smallint = source.weekday
where schedule.shift_date between date '2026-07-20' and date '2026-07-31';

with target_dates as (
  select generate_series(date '2026-07-20', date '2026-07-31', interval '1 day')::date as shift_date
), desired as (
  select source.*, target.shift_date as target_date
  from schedule_copy_source source
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
  desired.shift_sequence,
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
  'Copied from July 13-19 schedule pattern',
  desired.created_by,
  desired.updated_by,
  null,
  false,
  true,
  false
from desired
on conflict (user_id, shift_date, shift_sequence) do nothing;

insert into public.work_schedule_templates (
  name, timezone, is_active, created_by, updated_by
)
select distinct on (source.user_id)
  'User weekly schedule - ' || source.user_id::text,
  source.timezone,
  true,
  source.created_by,
  source.updated_by
from schedule_copy_source source
order by source.user_id, source.shift_date
on conflict ((lower(name))) do update
set timezone = excluded.timezone,
    is_active = true,
    updated_by = excluded.updated_by,
    updated_at = now();

delete from public.work_schedule_template_days template_day
using public.work_schedule_templates template,
      (select distinct user_id from schedule_copy_source) source_user
where template_day.template_id = template.id
  and lower(template.name) = lower('User weekly schedule - ' || source_user.user_id::text);

insert into public.work_schedule_template_days (
  template_id, weekday, shift_sequence, start_time, end_time,
  end_day_offset, is_rest_day
)
select
  template.id,
  source.weekday,
  source.shift_sequence,
  source.local_start_time,
  source.local_end_time,
  source.end_day_offset,
  source.is_rest_day
from schedule_copy_source source
join public.work_schedule_templates template
  on lower(template.name) = lower('User weekly schedule - ' || source.user_id::text)
on conflict (template_id, weekday, shift_sequence) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    end_day_offset = excluded.end_day_offset,
    is_rest_day = excluded.is_rest_day,
    updated_at = now();

update public.work_schedule_template_assignments assignment
set is_active = false,
    updated_at = now()
from (select distinct user_id from schedule_copy_source) source_user,
     public.work_schedule_templates template
where assignment.user_id = source_user.user_id
  and assignment.is_active
  and lower(template.name) = lower('User weekly schedule - ' || source_user.user_id::text)
  and assignment.template_id <> template.id;

insert into public.work_schedule_template_assignments (
  template_id, user_id, team_id, is_active, effective_from,
  effective_until, allow_admin_agent, created_by
)
select distinct on (source.user_id)
  template.id,
  source.user_id,
  null,
  true,
  date '2026-08-01',
  null,
  profile.base_role <> 'agent',
  source.created_by
from schedule_copy_source source
join public.profiles profile on profile.user_id = source.user_id
join public.work_schedule_templates template
  on lower(template.name) = lower('User weekly schedule - ' || source.user_id::text)
order by source.user_id, source.shift_date
on conflict (user_id) where user_id is not null and is_active do update
set template_id = excluded.template_id,
    effective_from = date '2026-08-01',
    effective_until = null,
    allow_admin_agent = excluded.allow_admin_agent,
    updated_at = now();

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
select
  'july_schedule_pattern_copied',
  'work_schedule',
  jsonb_build_object(
    'source_range', jsonb_build_array('2026-07-13', '2026-07-19'),
    'target_range', jsonb_build_array('2026-07-20', '2026-07-31'),
    'source_users', (select count(distinct user_id) from schedule_copy_source),
    'source_entries', (select count(*) from schedule_copy_source),
    'existing_slots_preserved', (select count(*) from schedule_copy_existing),
    'templates_effective_from', '2026-08-01',
    'existing_schedule_conflict_behavior', 'do_nothing'
  ),
  'Copied July 13-19 schedules through month end and activated August weekly automation without overwriting existing schedules';

commit;
