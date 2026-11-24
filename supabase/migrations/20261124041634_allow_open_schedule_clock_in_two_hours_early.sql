-- Allow a released Open Schedule to start at 10:00 PM on the previous
-- workforce-local date. Attendance stays attached to the scheduled work date.
begin;

do $realtime$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'work_schedules'
  ) then
    alter publication supabase_realtime add table public.work_schedules;
  end if;
end;
$realtime$;

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
          or (
            not (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_start is null
            and schedule.shift_end is null
            and schedule.shift_date = v_local_date
          )
    $old$,
    $new$
          or (
            not (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_start is null
            and schedule.shift_end is null
            and schedule.shift_date in (v_local_date, v_local_date + 1)
            and (
              schedule.shift_date = v_local_date
              or (v_clock_time at time zone v_timezone)::time >= time '22:00'
            )
          )
    $new$
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain the released Open Schedule eligibility branch';
  end if;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    $old$
      if v_schedule.shift_date not in (v_local_date - 1, v_local_date) then
        raise exception 'Open Schedule clock-in is available only on yesterday or the scheduled work date.';
      end if;
    $old$,
    $new$
      if v_schedule.shift_date not in (v_local_date - 1, v_local_date)
         and not (
           v_schedule.shift_date = v_local_date + 1
           and (v_clock_time at time zone v_timezone)::time >= time '22:00'
         ) then
        raise exception 'Open Schedule clock-in opens at 10:00 PM workforce time on the previous date.';
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
  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    where a.user_id = v_profile_user_id
    $old$,
    $new$
  if p_schedule_id is not null
     and v_schedule.shift_date = v_local_date + 1
     and not (v_schedule.is_rest_day or v_schedule.is_holiday)
     and v_schedule.shift_start is null
     and v_schedule.shift_end is null
     and (v_clock_time at time zone v_timezone)::time >= time '22:00'
     and exists (
       select 1
       from public.attendance a
       where a.user_id = v_profile_user_id
         and a.schedule_id = p_schedule_id
         and a.clock_in is not null
         and a.voided_at is null
     ) then
    raise exception 'Attendance for the selected Open Schedule has already been recorded.';
  end if;

  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    where a.user_id = v_profile_user_id
    $new$
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain the attendance lookup';
  end if;

  execute v_updated;
end;
$migration$;

comment on function public.workforce_clock_in(uuid) is
  'Allows a released Open Schedule to start at 10:00 PM in the workforce timezone on the prior date; attendance retains the selected schedule work date and actual clock-in timestamp.';

commit;
