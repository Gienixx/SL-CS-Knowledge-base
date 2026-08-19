-- Correct Almar's two remaining July schedules from the approved workbook's
-- ALMAR-sheet LOG IN / LOG OUT columns. Attendance punches are intentionally
-- preserved and recalculated against the corrected schedule boundaries.

begin;

do $$
declare
  v_almar_user_id constant uuid :=
    '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e'::uuid;
  v_source_hash constant text :=
    '949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590';
  v_target record;
  v_schedule public.work_schedules%rowtype;
  v_updated public.work_schedules%rowtype;
  v_attendance_id uuid;
begin
  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = v_almar_user_id
      and lower(profile.full_name) like 'almar%contreras%'
  ) then
    raise exception 'The expected Almar Contreras workforce profile was not found.';
  end if;

  for v_target in
    select *
    from (
      values
        (
          '9707b94d-9d4d-4f07-8496-8e72d7aecfb4'::uuid,
          date '2026-07-30',
          285,
          make_timestamptz(2026, 7, 30, 6, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 0, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 30, 10, 15, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 4, 15, 0, 'America/New_York')
        ),
        (
          'fdc0360d-e7dd-46de-b43a-51ef4f8ce7da'::uuid,
          date '2026-07-31',
          286,
          make_timestamptz(2026, 7, 31, 6, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 8, 1, 0, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 9, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 8, 1, 3, 0, 0, 'America/New_York')
        )
    ) as target(
      schedule_id,
      shift_date,
      source_row,
      expected_old_start,
      expected_old_end,
      corrected_start,
      corrected_end
    )
  loop
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = v_target.schedule_id
      and schedule.user_id = v_almar_user_id
      and schedule.shift_date = v_target.shift_date
      and schedule.shift_sequence = 1
    for update;

    if not found then
      raise exception 'Expected Almar schedule was not found for %.',
        v_target.shift_date;
    end if;

    if v_schedule.is_rest_day
       or v_schedule.is_holiday
       or v_schedule.planned_paid_minutes is not null then
      raise exception 'Almar schedule % is not the expected fixed ordinary shift.',
        v_target.shift_date;
    end if;

    if v_schedule.shift_start = v_target.corrected_start
       and v_schedule.shift_end = v_target.corrected_end then
      continue;
    end if;

    if v_schedule.shift_start is distinct from v_target.expected_old_start
       or v_schedule.shift_end is distinct from v_target.expected_old_end then
      raise exception 'Almar schedule % changed after validation; refusing to overwrite it.',
        v_target.shift_date;
    end if;

    if exists (
      select 1
      from public.attendance attendance_row
      where attendance_row.schedule_id = v_schedule.id
        and attendance_row.review_status = 'locked'
    ) then
      raise exception 'Almar attendance for % is locked and cannot be recalculated.',
        v_target.shift_date;
    end if;

    update public.work_schedules
    set
      shift_start = v_target.corrected_start,
      shift_end = v_target.corrected_end,
      status = case
        when status = 'published' then 'changed'
        else status
      end,
      updated_at = statement_timestamp()
    where id = v_schedule.id
    returning * into v_updated;

    for v_attendance_id in
      select attendance_row.id
      from public.attendance attendance_row
      where attendance_row.schedule_id = v_updated.id
        and attendance_row.review_status <> 'locked'
      order by attendance_row.clock_in, attendance_row.id
    loop
      perform public.workforce_recalculate_attendance(v_attendance_id);
    end loop;

    insert into public.workforce_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      null,
      'timesheet_schedule_correction',
      'work_schedule',
      v_updated.id,
      jsonb_build_object(
        'shift_date', v_schedule.shift_date,
        'shift_start', v_schedule.shift_start,
        'shift_end', v_schedule.shift_end,
        'schedule_version', v_schedule.schedule_version
      ),
      jsonb_build_object(
        'shift_date', v_updated.shift_date,
        'shift_start', v_updated.shift_start,
        'shift_end', v_updated.shift_end,
        'schedule_version', v_updated.schedule_version,
        'source_workbook', '2026 Support Timesheet.xlsx',
        'source_sheet', 'ALMAR',
        'source_row', v_target.source_row,
        'source_columns', 'E:F (LOG IN / LOG OUT)',
        'source_sha256', v_source_hash
      ),
      'Corrected from the approved workbook login/logout columns without changing attendance punches.'
    );
  end loop;
end;
$$;

commit;
