-- All blocker queries must return zero rows.

-- Every desired July 20-31 slot based on an existing July 13-19 weekday must exist.
with source as (
  select user_id, shift_sequence, extract(dow from shift_date)::integer weekday
  from public.work_schedules
  where shift_date between date '2026-07-13' and date '2026-07-19'
    and status in ('scheduled', 'published', 'changed', 'completed')
), targets as (
  select generate_series(date '2026-07-20', date '2026-07-31', interval '1 day')::date target_date
), desired as (
  select source.user_id, source.shift_sequence, target.target_date
  from source
  join targets target on extract(dow from target.target_date)::integer = source.weekday
)
select desired.*
from desired
left join public.work_schedules schedule
  on schedule.user_id = desired.user_id
 and schedule.shift_date = desired.target_date
 and schedule.shift_sequence = desired.shift_sequence
where schedule.id is null;

-- All nine users must have active August template assignments.
select source.user_id
from (
  select distinct user_id
  from public.work_schedules
  where shift_date between date '2026-07-13' and date '2026-07-19'
) source
left join public.work_schedule_template_assignments assignment
  on assignment.user_id = source.user_id
 and assignment.is_active
 and assignment.effective_from = date '2026-08-01'
where assignment.id is null;

-- The generator must preserve existing admin-added schedule slots.
select position(
  'on conflict (user_id, shift_date, shift_sequence) do nothing'
  in lower(pg_get_functiondef('public.workforce_generate_weekly_schedules(date)'::regprocedure))
) > 0 as automation_preserves_existing_schedules;

select action, after_data, created_at
from public.workforce_audit_logs
where action = 'july_schedule_pattern_copied'
order by created_at desc
limit 1;
