-- Allow an agent to link a real current clock-in to exactly yesterday's
-- released work schedule when that schedule has not already been attended.
-- Keep schedule ownership, release, leave/absence, date-window, open-session,
-- payroll, and downstream attendance-calculation safeguards unchanged.

begin;

do $migration$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure),
    chr(13),
    ''
  );

  v_updated := replace(
    v_definition,
    $old$
      if v_schedule.shift_date <> v_local_date then
        raise exception 'Open Schedule clock-in is available only on the scheduled work date.';
      end if;
    $old$,
    $new$
      if v_schedule.shift_date not in (v_local_date - 1, v_local_date) then
        raise exception 'Open Schedule clock-in is available only on yesterday or the scheduled work date.';
      end if;
    $new$
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain the Open Schedule date guard';
  end if;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    $old$
    if v_clock_time >= v_schedule.shift_end then
      raise exception 'This shift has already ended and is no longer available for clock-in.';
    end if;
    $old$,
    $new$
    if v_schedule.shift_date <> v_local_date - 1
       and v_clock_time >= v_schedule.shift_end then
      raise exception 'This shift has already ended and is no longer available for clock-in.';
    end if;
    $new$
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain the shift-end guard';
  end if;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    $old$
  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    $old$,
    $new$
  if p_schedule_id is not null
     and v_schedule.shift_date = v_local_date - 1
     and exists (
    select 1
    from public.attendance a
    where a.user_id = v_profile_user_id
      and a.schedule_id = p_schedule_id
      and a.clock_in is not null
      and a.voided_at is null
  ) then
    raise exception 'Attendance for the selected schedule has already been recorded.';
  end if;

  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    $new$
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain the schedule attendance lookup';
  end if;

  execute v_updated;
end;
$migration$;

comment on function public.workforce_clock_in(uuid) is
  'Clocks in the current agent to an unused released schedule from yesterday, today, or tomorrow within the existing attendance safeguards; yesterday links the actual current timestamp to the selected work date.';

commit;
