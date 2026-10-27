-- Batch Committed Hours targets for the cards currently visible in Team
-- Attendance. Each employee's FIFO summary is still produced by the existing
-- authorized single-employee RPC; only requested card dates are returned.
create or replace function public.workforce_get_visible_team_committed_hours_targets(
  p_employee_dates jsonb
)
returns table (
  employee_user_id uuid,
  work_date date,
  committed_hours jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_pair_count integer;
  v_employee record;
  v_work_date date;
  v_summary jsonb;
  v_target jsonb;
  v_target_found boolean;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view team attendance.';
  end if;

  if p_employee_dates is null or jsonb_typeof(p_employee_dates) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Employee and work-date pairs are required.';
  end if;

  v_pair_count := jsonb_array_length(p_employee_dates);
  if v_pair_count > 5 then
    raise exception using errcode = '22023',
      message = 'At most five visible attendance card targets may be requested at once.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_employee_dates) as request(
      employee_user_id uuid,
      work_date date
    )
    where request.employee_user_id is null or request.work_date is null
  ) then
    raise exception using errcode = '22004',
      message = 'Every Committed Hours target requires an employee and work date.';
  end if;

  if exists (
    select request.employee_user_id, request.work_date
    from jsonb_to_recordset(p_employee_dates) as request(
      employee_user_id uuid,
      work_date date
    )
    group by request.employee_user_id, request.work_date
    having count(*) > 1
  ) then
    raise exception using errcode = '22023',
      message = 'Duplicate employee and work-date targets are not allowed.';
  end if;

  for v_employee in
    select request.employee_user_id,
      min(request.work_date) as start_date,
      max(request.work_date) as end_date
    from jsonb_to_recordset(p_employee_dates) as request(
      employee_user_id uuid,
      work_date date
    )
    group by request.employee_user_id
  loop
    begin
      -- The existing RPC enforces employee scope and delegates FIFO to the
      -- canonical payroll helper. Its internal carryover history is retained.
      v_summary := public.workforce_get_team_committed_hours_targets(
        v_employee.employee_user_id,
        v_employee.start_date,
        v_employee.end_date
      );
    exception
      when insufficient_privilege then
        -- Match the team list behavior for rows with no visible CH target:
        -- return no CH data and reveal no target for an unauthorized employee.
        v_summary := '[]'::jsonb;
    end;

    for v_work_date in
      select distinct request.work_date
      from jsonb_to_recordset(p_employee_dates) as request(
        employee_user_id uuid,
        work_date date
      )
      where request.employee_user_id = v_employee.employee_user_id
      order by request.work_date
    loop
      v_target := null;
      select target.value
      into v_target
      from jsonb_array_elements(coalesce(v_summary, '[]'::jsonb)) as target(value)
      where target.value ->> 'work_date' = v_work_date::text
      limit 1;
      v_target_found := found;

      return query
      select v_employee.employee_user_id,
        v_work_date,
        case when v_target_found then v_target else null end;
    end loop;
  end loop;
end;
$function$;

comment on function public.workforce_get_visible_team_committed_hours_targets(jsonb) is
  'Batches at most five Team Attendance card employee/date targets through the existing authorized FIFO RPC and returns only requested target dates.';

revoke all on function public.workforce_get_visible_team_committed_hours_targets(jsonb)
  from public, anon, authenticated;
grant execute on function public.workforce_get_visible_team_committed_hours_targets(jsonb)
  to authenticated, service_role;

;
