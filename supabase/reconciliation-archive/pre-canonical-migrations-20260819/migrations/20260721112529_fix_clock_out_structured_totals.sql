begin;

create or replace function public.workforce_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_clock_time timestamptz := now();
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select attendance_row.*
  into v_existing
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
  order by attendance_row.clock_in desc
  limit 1
  for update;

  if not found then
    raise exception 'No open attendance record was found.';
  end if;

  if v_clock_time < v_existing.clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  -- Open sessions can contain a provisional pre-shift overtime estimate. If
  -- clock_out is written while those values remain, the row can temporarily
  -- violate attendance_structured_totals_check before recalculation runs.
  -- Move the row to the constraint's explicit pending-calculation state in
  -- the same update, then calculate the final totals below. Any failure rolls
  -- the entire function call back, including the clock-out timestamp.
  update public.attendance
  set clock_out = v_clock_time,
      pre_shift_overtime_minutes = null,
      regular_minutes = null,
      post_shift_overtime_minutes = null,
      rest_day_overtime_minutes = 0,
      holiday_overtime_minutes = 0,
      total_overtime_minutes = 0,
      overtime_minutes = 0,
      minutes_late = 0,
      is_late = false,
      undertime_minutes = 0,
      updated_by = v_auth_user_id
  where id = v_existing.id
  returning * into v_result;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

comment on function public.workforce_clock_out() is
  'Closes the current attendance session through a constraint-safe pending state, then recalculates trusted totals transactionally.';

revoke all on function public.workforce_clock_out() from public;
revoke all on function public.workforce_clock_out() from anon;
grant execute on function public.workforce_clock_out() to authenticated;
grant execute on function public.workforce_clock_out() to service_role;

commit;
