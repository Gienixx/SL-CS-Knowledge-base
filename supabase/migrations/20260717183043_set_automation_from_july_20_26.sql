-- Use the complete July 20-26 week as the live weekly automation pattern.
-- The generator retains ON CONFLICT DO NOTHING, so admin schedules win.

begin;

create temporary table automation_pattern_source on commit drop as
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
where schedule.shift_date between date '2026-07-20' and date '2026-07-26'
  and schedule.status in ('scheduled', 'published', 'changed', 'completed');

do $$
declare
  v_users integer;
  v_entries integer;
  v_complete_users integer;
begin
  select count(distinct user_id), count(*)
  into v_users, v_entries
  from automation_pattern_source;

  select count(*) into v_complete_users
  from (
    select user_id
    from automation_pattern_source
    group by user_id
    having count(*) = 7 and count(distinct shift_date) = 7
  ) complete;

  if v_users <> 9 or v_entries <> 63 or v_complete_users <> 9 then
    raise exception 'July 20-26 source changed: expected 9 complete users and 63 entries; found %, % entries and % complete users.',
      v_users, v_entries, v_complete_users;
  end if;

  if position(
    'on conflict (user_id, shift_date, shift_sequence) do nothing'
    in lower(pg_get_functiondef('public.workforce_generate_weekly_schedules(date)'::regprocedure))
  ) = 0 then
    raise exception 'Weekly generator no longer preserves existing admin schedules.';
  end if;
end;
$$;

delete from public.work_schedule_template_days template_day
using public.work_schedule_templates template,
      (select distinct user_id from automation_pattern_source) source_user
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
from automation_pattern_source source
join public.work_schedule_templates template
  on lower(template.name) = lower('User weekly schedule - ' || source.user_id::text);

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
values (
  'weekly_automation_pattern_updated',
  'work_schedule_template',
  jsonb_build_object(
    'source_range', jsonb_build_array('2026-07-20', '2026-07-26'),
    'users', 9,
    'template_entries', 63,
    'effective_from', '2026-08-01',
    'existing_admin_schedules', 'preserved_by_conflict_skip'
  ),
  'Updated weekly automation to the complete July 20-26 pattern'
);

commit;
