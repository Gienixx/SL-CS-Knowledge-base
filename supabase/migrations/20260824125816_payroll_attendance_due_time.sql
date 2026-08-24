-- A scheduled attendance entry is due only after its canonical scheduled end
-- timestamp has passed. This deliberately does not infer attendance from
-- prepaid/preplot approval and does not alter any attendance-level blocker.
begin;

create or replace function public.payroll_attendance_is_due(
  p_schedule_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.work_schedules as schedule
    where schedule.id = p_schedule_id
      and schedule.is_leave is false
      and schedule.is_absent is false
      and schedule.is_rest_day is false
      and schedule.is_holiday is false
      and schedule.shift_start is not null
      and schedule.shift_end is not null
      and schedule.shift_end > schedule.shift_start
      and schedule.shift_end <= coalesce(p_as_of, statement_timestamp())
  );
$$;

revoke all on function public.payroll_attendance_is_due(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.payroll_attendance_is_due(uuid, timestamptz)
  to service_role;

comment on function public.payroll_attendance_is_due(uuid, timestamptz) is
  'Returns true only when a valid timed, non-leave attendance schedule has passed its canonical scheduled end timestamp.';

-- Patch the live readiness function while preserving its return contract and
-- scheduled-shift denominator. Only the missing-attendance filter is due-time
-- gated.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.payroll_get_period_employee_readiness_base(uuid)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    $anchor$        count(*) filter (
          where not exists (
            select 1
            from public.attendance as attendance_row
            where attendance_row.user_id = profile.user_id
              and attendance_row.schedule_id = schedule.id
              and attendance_row.voided_at is null
          )
        ) as missing_attendance_count$anchor$,
    $replacement$        count(*) filter (
          where public.payroll_attendance_is_due(schedule.id, statement_timestamp())
            and not exists (
              select 1
              from public.attendance as attendance_row
              where attendance_row.user_id = profile.user_id
                and attendance_row.schedule_id = schedule.id
                and attendance_row.voided_at is null
            )
        ) as missing_attendance_count$replacement$
  );

  if v_updated = v_definition
     or position('payroll_attendance_is_due(schedule.id, statement_timestamp())' in v_updated) = 0 then
    raise exception 'Payroll readiness function did not expose the expected missing-attendance predicate.';
  end if;

  execute v_updated;
end;
$$;

-- Patch the navigation/link RPC with the same predicate. Leave, absence,
-- untimed, future, and in-progress schedules therefore do not create links.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.payroll_get_period_missing_attendance_base(uuid)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    $anchor$    and schedule.is_holiday is false
    and not exists ($anchor$,
    $replacement$    and schedule.is_holiday is false
    and public.payroll_attendance_is_due(schedule.id, statement_timestamp())
    and not exists ($replacement$
  );

  if v_updated = v_definition
     or position('payroll_attendance_is_due(schedule.id, statement_timestamp())' in v_updated) = 0 then
    raise exception 'Missing-attendance link function did not expose the expected due predicate.';
  end if;

  execute v_updated;
end;
$$;

-- Keep active_schedules available for overlap and other schedule controls.
-- Apply due-time filtering only to the missing-attendance exception branch so
-- future overlap/duplicate protections and prepaid/preplot controls remain.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.payroll_get_period_exceptions_base(uuid)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    $anchor$    from active_schedules as schedule
    where not exists ($anchor$,
    $replacement$    from active_schedules as schedule
    where public.payroll_attendance_is_due(schedule.schedule_id, statement_timestamp())
      and not exists ($replacement$
  );

  if v_updated = v_definition
     or position('payroll_attendance_is_due(schedule.schedule_id, statement_timestamp())' in v_updated) = 0 then
    raise exception 'Payroll exception function did not expose the expected due predicate.';
  end if;

  execute v_updated;
end;
$$;

-- The import RPC reports missing attendance in its audit/result payload. Keep
-- that derived count aligned with readiness and exception generation without
-- changing snapshot selection or import behavior.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.payroll_import_attendance(uuid,uuid)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    $anchor$   and schedule.is_holiday is false
  where record.payroll_period_id = v_period.id$anchor$,
    $replacement$   and schedule.is_holiday is false
   and public.payroll_attendance_is_due(schedule.id, statement_timestamp())
  where record.payroll_period_id = v_period.id$replacement$
  );

  if v_updated = v_definition
     or position('payroll_attendance_is_due(schedule.id, statement_timestamp())' in v_updated) = 0 then
    raise exception 'Payroll import function did not expose the expected due predicate.';
  end if;

  execute v_updated;
end;
$$;

commit;
