-- Approved pre-plots remain reviewable even when the payroll payment date is
-- the cutoff date. Unapproved rows are still limited to post-payment shifts.

begin;

create or replace function public.payroll_get_preplot_candidates(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  schedule_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  work_date date,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text,
  scheduled_minutes integer,
  schedule_status text,
  is_rest_day boolean,
  is_holiday boolean,
  holiday_name text,
  special_day_type text,
  schedule_version bigint,
  schedule_updated_at timestamptz,
  can_approve boolean,
  approval_status text,
  approval_message text,
  current_snapshot_id uuid,
  approved_at timestamptz,
  approval_reason text,
  approved_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view payroll pre-plots.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  return query
  select
    record.id,
    schedule.id,
    profile.user_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    schedule.shift_date,
    coalesce(current_approval.shift_start, schedule.shift_start),
    coalesce(current_approval.shift_end, schedule.shift_end),
    coalesce(current_approval.timezone, schedule.timezone),
    coalesce(
      current_approval.scheduled_minutes,
      case
        when schedule.shift_start is null or schedule.shift_end is null then 0
        else floor(
          extract(epoch from (schedule.shift_end - schedule.shift_start)) / 60
        )::integer
      end
    ),
    schedule.status,
    schedule.is_rest_day,
    schedule.is_holiday,
    schedule.holiday_name,
    case
      when schedule.is_rest_day then 'rest_day'
      when schedule.is_holiday then 'holiday'
      else 'ordinary'
    end,
    schedule.schedule_version,
    schedule.updated_at,
    (
      schedule.shift_date > v_period.payment_date
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and schedule.shift_start is not null
      and schedule.shift_end is not null
      and schedule.shift_end > schedule.shift_start
      and attendance_status.attendance_id is null
      and current_approval.snapshot_id is null
    ),
    case
      when current_approval.snapshot_id is not null then 'approved'
      when attendance_status.attendance_id is not null then 'attendance_exists'
      when schedule.is_rest_day then 'rest_day'
      when schedule.is_holiday then 'guaranteed_special_day'
      when schedule.status not in ('published', 'changed') then 'unpublished'
      when schedule.shift_start is null or schedule.shift_end is null
        then 'incomplete_shift'
      when schedule.shift_end <= schedule.shift_start then 'invalid_shift'
      when previous_approval.has_previous then 'schedule_changed'
      else 'eligible'
    end,
    case
      when current_approval.snapshot_id is not null
        then 'This exact schedule version is approved.'
      when attendance_status.attendance_id is not null
        then 'Attendance already exists; use approved attendance instead.'
      when schedule.is_rest_day
        then 'Rest days do not create prepaid-hour debt.'
      when schedule.is_holiday
        then 'Guaranteed special-day pay remains additional and is not prepaid debt.'
      when schedule.status not in ('published', 'changed')
        then 'Only published or changed schedules may be pre-plotted.'
      when schedule.shift_start is null or schedule.shift_end is null
        then 'Complete shift times are required.'
      when schedule.shift_end <= schedule.shift_start
        then 'Shift end must be after shift start.'
      when previous_approval.has_previous
        then 'The schedule changed after an earlier approval; approve this version again.'
      else 'Eligible for explicit pre-plot approval.'
    end,
    current_approval.snapshot_id,
    current_approval.approved_at,
    current_approval.approval_reason,
    current_approval.approved_by_name
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  join public.work_schedules as schedule
    on schedule.user_id = record.employee_id
   and schedule.shift_date between v_period.period_start and v_period.period_end
   and (
     schedule.shift_date > v_period.payment_date
     or exists (
       select 1
       from public.payroll_schedule_snapshots as approved_snapshot
       where approved_snapshot.payroll_record_id = record.id
         and approved_snapshot.employee_id = record.employee_id
         and approved_snapshot.schedule_id = schedule.id
         and approved_snapshot.schedule_version = schedule.schedule_version
     )
   )
  left join lateral (
    select attendance_row.id as attendance_id
    from public.attendance as attendance_row
    where attendance_row.user_id = record.employee_id
      and attendance_row.schedule_id = schedule.id
    order by attendance_row.created_at
    limit 1
  ) as attendance_status on true
  left join lateral (
    select
      snapshot.id as snapshot_id,
      snapshot.shift_start,
      snapshot.shift_end,
      snapshot.timezone,
      snapshot.scheduled_minutes,
      snapshot.approved_at,
      snapshot.approval_reason,
      approver.full_name as approved_by_name
    from public.payroll_schedule_snapshots as snapshot
    join public.profiles as approver
      on approver.user_id = snapshot.approved_by
    where snapshot.payroll_record_id = record.id
      and snapshot.employee_id = record.employee_id
      and snapshot.schedule_id = schedule.id
      and snapshot.schedule_version = schedule.schedule_version
    order by snapshot.approved_at desc
    limit 1
  ) as current_approval on true
  left join lateral (
    select exists (
      select 1
      from public.payroll_schedule_snapshots as snapshot
      where snapshot.payroll_record_id = record.id
        and snapshot.employee_id = record.employee_id
        and snapshot.schedule_id = schedule.id
    ) as has_previous
  ) as previous_approval on true
  where record.payroll_period_id = v_period.id
    and record.status <> 'void'
  order by schedule.shift_date, profile.full_name, schedule.shift_start, schedule.id;
end;
$$;

revoke all on function public.payroll_get_preplot_candidates(uuid)
  from public, anon;
grant execute on function public.payroll_get_preplot_candidates(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_preplot_candidates(uuid) is
  'Returns approved pre-plots for audit review plus unapproved post-payment candidates, using immutable snapshot times for approved rows.';

commit;
