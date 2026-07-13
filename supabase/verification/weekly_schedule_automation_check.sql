-- Run after deploying 20260713150918_weekly_schedule_automation.sql.

select
  to_regclass('public.work_schedule_templates') is not null as templates_exist,
  to_regclass('public.work_schedule_template_days') is not null as template_days_exist,
  to_regclass('public.work_schedule_template_assignments') is not null as assignments_exist,
  to_regprocedure('public.workforce_generate_weekly_schedules(date)') is not null as generator_exists,
  to_regprocedure('public.workforce_run_weekly_schedule_cron()') is not null as cron_wrapper_exists;

select
  template.name,
  template.timezone,
  profile.email,
  assignment.user_id is not null and assignment.team_id is null as user_only_test_assignment
from public.work_schedule_template_assignments assignment
join public.work_schedule_templates template on template.id = assignment.template_id
left join public.profiles profile on profile.user_id = assignment.user_id
where lower(profile.email) = 'arby@eurekasurveys.com';

select weekday, start_time, end_time, is_rest_day
from public.work_schedule_template_days template_day
join public.work_schedule_templates template on template.id = template_day.template_id
where template.name = 'Arby weekly schedule test'
order by weekday;

select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'workforce-weekly-schedule-generator';

-- Idempotency check: the second call should return zero after the week exists.
select public.workforce_generate_weekly_schedules() as first_generation_insert_count;
select public.workforce_generate_weekly_schedules() as second_generation_must_be_zero;

select shift_date, shift_start, shift_end, status, is_rest_day,
       generated_by_automation, admin_override, automation_leave_cancelled
from public.work_schedules schedule
join public.profiles profile on profile.user_id = schedule.user_id
where lower(profile.email) = 'arby@eurekasurveys.com'
  and schedule.shift_date between
    ((now() at time zone 'America/New_York')::date - extract(dow from (now() at time zone 'America/New_York')::date)::integer)
    and
    ((now() at time zone 'America/New_York')::date - extract(dow from (now() at time zone 'America/New_York')::date)::integer + 6)
order by shift_date, shift_sequence;
