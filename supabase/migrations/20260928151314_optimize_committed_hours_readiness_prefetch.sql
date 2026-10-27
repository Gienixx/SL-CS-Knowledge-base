-- Prefetch approved, payroll-ready attendance once per CH FIFO window.
create or replace function public.payroll_get_expected_committed_hours_summary(
  p_employee_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_first_date date;
  v_day date;
  v_queue jsonb := '[]'::jsonb;
  v_open_queue jsonb := '[]'::jsonb;
  v_targets jsonb := '[]'::jsonb;
  v_carryover_targets jsonb := '[]'::jsonb;
  v_payroll_targets jsonb := '[]'::jsonb;
  v_days jsonb := '[]'::jsonb;
  v_target jsonb;
  v_attendance record;
  v_attendance_by_day jsonb := '{}'::jsonb;
  v_target_row record;
  v_index integer;
  v_day_ready integer;
  v_day_used integer;
  v_day_carryover integer;
  v_day_target_minutes integer;
  v_day_expected_minutes integer;
  v_attendance_minutes integer;
  v_apply integer;
  v_target_remaining integer;
  v_opening_carryover integer := 0;
  v_current_target_minutes integer := 0;
  v_expected_minutes integer := 0;
  v_credited_minutes integer := 0;
  v_remaining_minutes integer := 0;
  v_paid_minutes integer;
  v_queue_length integer;
  v_status text;
begin
  if p_employee_user_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Employee and date range are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Committed Hours date ranges cannot exceed 367 calendar days.';
  end if;

  select min(commitment.work_date)
  into v_first_date
  from public.payroll_prepaid_commitments commitment
  where commitment.employee_id = p_employee_user_id
    and commitment.work_date <= p_end_date
    and commitment.superseded_at is null;

  if v_first_date is null then
    return jsonb_build_object(
      'expected_minutes', 0, 'target_minutes', 0, 'carryover_minutes', 0,
      'payroll_ready_minutes', 0,
      'covered_minutes', 0, 'credited_minutes', 0, 'remaining_minutes', 0,
      'status', 'No commitment required', 'targets', '[]'::jsonb,
      'carryover_targets', '[]'::jsonb, 'payroll_targets', '[]'::jsonb,
      'days', '[]'::jsonb
    );
  end if;

  -- Read eligible attendance once for the full FIFO window instead of
  -- re-running the payroll-readiness view once for each calendar day.
  select coalesce(jsonb_object_agg(attendance_days.work_date::text, attendance_days.rows), '{}'::jsonb)
  into v_attendance_by_day
  from (
    select readiness.work_date,
      jsonb_agg(jsonb_build_object(
        'id', readiness.id,
        'work_date', readiness.work_date,
        'eligible_minutes', case
          when public.payroll_expected_commitment_day_type(p_employee_user_id, readiness.work_date) = 'rest_day'
            then greatest(coalesce(readiness.rest_day_overtime_minutes, 0), 0)
          else greatest(coalesce(readiness.regular_minutes, 0), 0)
        end::integer
      ) order by readiness.id) as rows
    from public.workforce_attendance_payroll_readiness readiness
    where readiness.user_id = p_employee_user_id
      and readiness.work_date between v_first_date and p_end_date
      and readiness.is_payroll_ready
      and readiness.review_status in ('approved', 'locked')
    group by readiness.work_date
  ) attendance_days;

  if p_start_date < v_first_date then
    v_open_queue := '[]'::jsonb;
  end if;

  for v_day in
    select generated.work_date::date
    from generate_series(v_first_date, p_end_date, interval '1 day') generated(work_date)
    order by generated.work_date
  loop
    -- Capture the debt at the boundary before this range's first target is due.
    if v_day = p_start_date then
      v_open_queue := '[]'::jsonb;
      v_queue_length := jsonb_array_length(v_queue);
      if v_queue_length > 0 then
        for v_index in 0..v_queue_length - 1 loop
          v_target := v_queue -> v_index;
          if (v_target ->> 'work_date')::date < p_start_date
             and coalesce((v_target ->> 'remaining_minutes')::integer, 0) > 0 then
            v_target := jsonb_set(
              v_target, '{carryover_minutes}', v_target -> 'remaining_minutes', true
            );
            v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);
            v_open_queue := v_open_queue || jsonb_build_array(v_target);
            v_opening_carryover := v_opening_carryover
              + (v_target ->> 'remaining_minutes')::integer;
          end if;
        end loop;
      end if;
    end if;

    v_day_ready := 0;
    v_day_used := 0;
    v_day_carryover := 0;
    v_day_target_minutes := 0;

    for v_target_row in
      select commitment.id, commitment.work_date, commitment.expected_minutes,
        commitment.commitment_version, commitment.prepaid_day_type
      from public.payroll_prepaid_commitments commitment
      where commitment.employee_id = p_employee_user_id
        and commitment.work_date = v_day
        and commitment.superseded_at is null
      order by commitment.work_date, commitment.created_at, commitment.id
    loop
      v_queue := v_queue || jsonb_build_array(jsonb_build_object(
        'commitment_id', v_target_row.id,
        'work_date', v_target_row.work_date,
        'expected_minutes', v_target_row.expected_minutes,
        'payroll_ready_minutes', 0,
        'covered_minutes', 0,
        'remaining_minutes', v_target_row.expected_minutes,
        'carryover_minutes', 0,
        'payable_minutes', 0,
        'already_paid_minutes', 0,
        'day_type', v_target_row.prepaid_day_type,
        'commitment_version', v_target_row.commitment_version,
        'attendance_sources', '[]'::jsonb,
        'source_attendance_ids', '[]'::jsonb
      ));
      if v_day between p_start_date and p_end_date then
        v_current_target_minutes := v_current_target_minutes + v_target_row.expected_minutes;
        v_day_target_minutes := v_day_target_minutes + v_target_row.expected_minutes;
      end if;
    end loop;

    select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
    into v_day_carryover
    from jsonb_array_elements(v_queue) target(value)
    where (target.value ->> 'work_date')::date < v_day;
    v_day_expected_minutes := v_day_carryover + v_day_target_minutes;

    -- Process approved, payroll-ready attendance records individually so each
    -- attendance ID and each eligible minute can be allocated at most once.
    for v_attendance in
      select (attendance_row.value ->> 'id')::uuid as id,
        (attendance_row.value ->> 'work_date')::date as work_date,
        greatest(coalesce((attendance_row.value ->> 'eligible_minutes')::integer, 0), 0)::integer as eligible_minutes
      from jsonb_array_elements(
        coalesce(v_attendance_by_day -> v_day::text, '[]'::jsonb)
      ) with ordinality attendance_row(value, ordinal_position)
      order by attendance_row.ordinal_position
    loop
      v_attendance_minutes := greatest(coalesce(v_attendance.eligible_minutes, 0), 0);
      v_day_ready := v_day_ready + v_attendance_minutes;
      v_queue_length := jsonb_array_length(v_queue);

      if v_attendance_minutes > 0 and v_queue_length > 0 then
        for v_index in 0..v_queue_length - 1 loop
          exit when v_attendance_minutes <= 0;
          v_target := v_queue -> v_index;
          if (v_target ->> 'work_date')::date > v_day then
            continue;
          end if;
          v_target_remaining := greatest(coalesce((v_target ->> 'remaining_minutes')::integer, 0), 0);
          if v_target_remaining <= 0 then
            continue;
          end if;

          v_apply := least(v_target_remaining, v_attendance_minutes);
          v_target := jsonb_set(v_target, '{remaining_minutes}', to_jsonb(v_target_remaining - v_apply), true);
          v_target := jsonb_set(v_target, '{covered_minutes}', to_jsonb(
            coalesce((v_target ->> 'covered_minutes')::integer, 0) + v_apply
          ), true);
          v_target := jsonb_set(v_target, '{payroll_ready_minutes}', to_jsonb(
            coalesce((v_target ->> 'payroll_ready_minutes')::integer, 0) + v_apply
          ), true);
          v_target := jsonb_set(v_target, '{attendance_sources}',
            coalesce(v_target -> 'attendance_sources', '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object(
                'attendance_id', v_attendance.id,
                'work_date', v_day,
                'minutes', v_apply
              )), true);
          if not coalesce(v_target -> 'source_attendance_ids', '[]'::jsonb) @> jsonb_build_array(v_attendance.id) then
            v_target := jsonb_set(v_target, '{source_attendance_ids}',
              coalesce(v_target -> 'source_attendance_ids', '[]'::jsonb)
                || jsonb_build_array(v_attendance.id), true);
          end if;
          v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);
          v_attendance_minutes := v_attendance_minutes - v_apply;
          v_day_used := v_day_used + v_apply;
        end loop;
      end if;
    end loop;

    if v_day between p_start_date and p_end_date then
      select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
      into v_remaining_minutes
      from jsonb_array_elements(v_queue) target(value);

      select coalesce(jsonb_agg(jsonb_build_object(
        'commitment_id', target.value -> 'commitment_id',
        'work_date', target.value -> 'work_date',
        'expected_minutes', (target.value ->> 'expected_minutes')::integer,
        'credited_minutes', (target.value ->> 'covered_minutes')::integer,
        'remaining_minutes', (target.value ->> 'remaining_minutes')::integer,
        'source_attendance_ids', coalesce(target.value -> 'source_attendance_ids', '[]'::jsonb),
        'attendance_sources', coalesce(target.value -> 'attendance_sources', '[]'::jsonb),
        'day_type', target.value -> 'day_type',
        'commitment_version', target.value -> 'commitment_version'
      ) order by target.value ->> 'work_date'), '[]'::jsonb)
      into v_target
      from jsonb_array_elements(v_queue) target(value)
      where (target.value ->> 'work_date')::date = v_day;

      if v_day_expected_minutes = 0 then
        v_status := 'No commitment required';
      elsif v_remaining_minutes = 0 then
        v_status := 'Complete';
      elsif v_day_used = 0 then
        v_status := 'Outstanding';
      else
        v_status := 'Partially covered';
      end if;

      if v_day_used > 0 or jsonb_array_length(v_target) > 0 or v_remaining_minutes > 0 then
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'work_date', v_day,
          'target_minutes', v_day_target_minutes,
          'carryover_minutes', v_day_carryover,
          'expected_minutes', v_day_expected_minutes,
          'credited_minutes', v_day_used,
          'payroll_ready_minutes', v_day_used,
          'remaining_minutes', v_remaining_minutes,
          'status', case
            when v_day_expected_minutes = 0 then 'No commitment required'
            when v_remaining_minutes = 0 then 'Complete'
            when v_day_used = 0 then 'Outstanding'
            else 'Partially covered'
          end,
          'targets', v_target
        ));
      end if;
    end if;
  end loop;

  v_queue_length := jsonb_array_length(v_queue);
  if v_queue_length > 0 then
    for v_index in 0..v_queue_length - 1 loop
      v_target := v_queue -> v_index;
      select coalesce(sum(paid.paid_minutes), 0)::integer
      into v_paid_minutes
      from (
        select greatest(item.minutes, 0)::integer as paid_minutes
        from public.payroll_v2_committed_hours_snapshots snapshot
        join public.payroll_v2_records record on record.id = snapshot.payroll_v2_record_id
        join public.payroll_v2_items item
          on item.payroll_v2_record_id = record.id
         and item.item_type = 'committed_hours'
         and item.source_type = 'payroll_prepaid_commitments'
         and item.source_id = snapshot.commitment_source_id
        where snapshot.commitment_source_id = (v_target ->> 'commitment_id')::uuid
          and snapshot.employee_user_id = p_employee_user_id
          and record.status <> 'void'
        union all
        select greatest(round(item.quantity * 60), 0)::integer
        from public.payroll_items item
        join public.payroll_records record on record.id = item.payroll_record_id
        where item.metadata ->> 'commitment_id' = v_target ->> 'commitment_id'
          and item.quantity is not null
          and record.status <> 'void'
      ) paid;
      v_paid_minutes := greatest(coalesce(v_paid_minutes, 0), 0);
      v_target := jsonb_set(v_target, '{already_paid_minutes}', to_jsonb(v_paid_minutes), true);
      v_target := jsonb_set(v_target, '{payable_minutes}', to_jsonb(greatest(
        coalesce((v_target ->> 'remaining_minutes')::integer, 0) - v_paid_minutes, 0
      )), true);
      v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);

      if (v_target ->> 'work_date')::date between p_start_date and p_end_date then
        v_targets := v_targets || jsonb_build_array(v_target);
        v_payroll_targets := v_payroll_targets || jsonb_build_array(v_target);
      elsif coalesce((v_target ->> 'carryover_minutes')::integer, 0) > 0 then
        v_carryover_targets := v_carryover_targets || jsonb_build_array(v_target);
        v_payroll_targets := v_payroll_targets || jsonb_build_array(v_target);
      end if;
    end loop;
  end if;

  select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
  into v_remaining_minutes
  from jsonb_array_elements(v_queue) target(value);
  v_expected_minutes := v_opening_carryover + v_current_target_minutes;
  v_credited_minutes := greatest(v_expected_minutes - v_remaining_minutes, 0);

  if v_expected_minutes = 0 then
    v_status := 'No commitment required';
  elsif v_remaining_minutes = 0 then
    v_status := 'Complete';
  elsif v_credited_minutes = 0 then
    v_status := 'Outstanding';
  else
    v_status := 'Partially covered';
  end if;

  return jsonb_build_object(
    'expected_minutes', v_expected_minutes,
    'target_minutes', v_current_target_minutes,
    'carryover_minutes', v_opening_carryover,
    'payroll_ready_minutes', v_credited_minutes,
    'covered_minutes', v_credited_minutes,
    'credited_minutes', v_credited_minutes,
    'remaining_minutes', v_remaining_minutes,
    'status', v_status,
    'targets', v_targets,
    'carryover_targets', v_carryover_targets,
    'payroll_targets', v_payroll_targets,
    'days', v_days
  );
end;
$function$;

;
