create or replace function public.workforce_admin_list_committed_hours(
  p_start_date date,
  p_end_date date,
  p_employee_user_id uuid default null,
  p_team_id uuid default null
) returns table(
  employee_user_id uuid,
  employee_name text,
  team_id uuid,
  team_name text,
  commitment_id uuid,
  work_date date,
  target_minutes integer,
  fulfilled_minutes integer,
  carryover_minutes integer,
  remaining_minutes integer,
  status text,
  reason text,
  editable boolean
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is null
    or public.workforce_current_profile_id() is null
    or not public.workforce_current_user_is_active()
    or not public.workforce_has_permission('manage_employees') then
    raise exception using errcode = '42501', message = 'You do not have permission to manage Committed Hours.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Committed Hours date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    profile.user_id,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.team_id,
    employee_team.name,
    (target.value ->> 'commitment_id')::uuid,
    (target.value ->> 'work_date')::date,
    (target.value ->> 'expected_minutes')::integer,
    coalesce(
      (target.value ->> 'covered_minutes')::integer,
      (target.value ->> 'credited_minutes')::integer,
      0
    ),
    coalesce((target.value ->> 'carryover_minutes')::integer, 0),
    (target.value ->> 'remaining_minutes')::integer,
    case
      when (target.value ->> 'remaining_minutes')::integer = 0 then 'Complete'
      when coalesce(
        (target.value ->> 'covered_minutes')::integer,
        (target.value ->> 'credited_minutes')::integer,
        0
      ) = 0 then 'Outstanding'
      else 'Partially covered'
    end,
    commitment.reason,
    not exists (
      select 1
      from public.payroll_v2_committed_hours_snapshots snapshot
      join public.payroll_v2_records record
        on record.id = snapshot.payroll_v2_record_id
      where snapshot.commitment_source_id = commitment.id
        and record.status <> 'void'
    )
    and not exists (
      select 1
      from public.payroll_items item
      join public.payroll_records record
        on record.id = item.payroll_record_id
      where item.metadata ->> 'commitment_id' = commitment.id::text
        and record.status <> 'void'
    )
  from public.profiles profile
  left join public.teams employee_team
    on employee_team.id = profile.team_id
  cross join lateral (
    select public.payroll_get_expected_committed_hours_summary(
      profile.user_id,
      p_start_date,
      p_end_date
    ) as value
  ) summary
  cross join lateral (
    select distinct on (candidate.value ->> 'commitment_id')
      candidate.value
    from (
      select payroll_target.value, 0 as source_priority
      from jsonb_array_elements(
        coalesce(summary.value -> 'payroll_targets', '[]'::jsonb)
      ) payroll_target(value)

      union all

      select daily_target.value, 1 as source_priority
      from jsonb_array_elements(
        coalesce(summary.value -> 'days', '[]'::jsonb)
      ) day(value)
      cross join lateral jsonb_array_elements(
        coalesce(day.value -> 'targets', '[]'::jsonb)
      ) daily_target(value)
      where (daily_target.value ->> 'work_date')::date
        between p_start_date and p_end_date
    ) candidate
    where candidate.value ? 'commitment_id'
    order by candidate.value ->> 'commitment_id', candidate.source_priority
  ) target
  join public.payroll_prepaid_commitments commitment
    on commitment.id = (target.value ->> 'commitment_id')::uuid
    and commitment.superseded_at is null
  where profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
    and (p_employee_user_id is null or profile.user_id = p_employee_user_id)
    and (p_team_id is null or profile.team_id = p_team_id)
    and public.workforce_can_manage_user(profile.user_id, 'manage_employees')
  order by
    (target.value ->> 'work_date')::date,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.user_id;
end;
$function$;
