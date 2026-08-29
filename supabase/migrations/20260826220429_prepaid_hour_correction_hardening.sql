begin;

-- Keep historical versions while enforcing one current version per immutable
-- source snapshot, including for service-role or direct writes.
create unique index payroll_prepaid_hours_one_active_version_idx
  on public.payroll_prepaid_hours (source_schedule_snapshot_id)
  where voided_at is null;

-- The partial unique index requires the new row to be staged as voided while
-- the previous version is superseded.  All three operations remain atomic.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_correct_prepaid_hours(uuid,date,time without time zone,time without time zone,text,text)'::regprocedure
  ), chr(13), '');

  if position('Only the current active prepaid version can be edited.' in v_definition) = 0
     or position('Pending audited prepaid correction version.' in v_definition) > 0 then
    raise exception 'payroll_correct_prepaid_hours is not the expected pre-hardening version';
  end if;

  v_updated := replace(
    v_definition,
    '  v_target_schedule public.work_schedules%rowtype;' || chr(10),
    '  v_target_schedule public.work_schedules%rowtype;' || chr(10) ||
    '  v_profile public.profiles%rowtype;' || chr(10)
  );

  v_updated := replace(
    v_updated,
    $record$  if not found then
    raise exception
      using errcode = '55000', message = 'The prepaid payroll record is missing.';
  end if;

  select period.*$record$,
    $record$
  if not found then
    raise exception
      using errcode = '55000', message = 'The prepaid payroll record is missing.';
  end if;

  select profile.*
  into v_profile
  from public.profiles as profile
  where profile.user_id = v_old.employee_id;

  if not found
     or v_profile.is_agent is not true
     or v_profile.employment_status not in ('active', 'on_leave') then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid corrections require an active or on-leave agent.';
  end if;

  select period.*$record$
  );

  v_updated := replace(
    v_updated,
    '  if v_schedule_count = 1 then',
    '  if v_schedule_count = 0 then' || chr(10) ||
    '    -- Initial creation may create an Open Schedule with schedule-management' || chr(10) ||
    '    -- permission. Correction never changes a live schedule, so its target' || chr(10) ||
    '    -- date must already have a source schedule.' || chr(10) ||
    '    raise exception' || chr(10) ||
    '      using' || chr(10) ||
    '        errcode = ''22023'',' || chr(10) ||
    '        message = ''A source schedule is required for the corrected prepaid work date.'';' || chr(10) ||
    '  end if;' || chr(10) || chr(10) ||
    '  if v_schedule_count = 1 then'
  );

  -- Leave/VL remains governed by the existing prepaid policy: initial prepaid
  -- creation does not reject leave schedules, and paid-leave earnings remain
  -- independent. No leave schedule is created or modified here.

  v_updated := replace(
    v_updated,
    $insert$  insert into public.payroll_prepaid_hours (
    source_payroll_record_id,
    source_schedule_snapshot_id,
    employee_id,
    prepaid_minutes,
    settled_minutes,
    prepaid_version,
    correction_of_id,
    effective_work_date,
    effective_shift_start,
    effective_shift_end,
    effective_timezone,
    correction_reason,
    corrected_by,
    corrected_at,
    created_by,
    created_at,
    updated_at
  )
  values (
    v_old.source_payroll_record_id,
    v_old.source_schedule_snapshot_id,
    v_old.employee_id,
    v_minutes,
    0,
    v_old.prepaid_version + 1,
    v_old.id,
    p_work_date,
    v_shift_start,
    v_shift_end,
    v_timezone,
    v_reason,
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  )
  returning id into v_new_id;$insert$,
    $insert$
  insert into public.payroll_prepaid_hours (
    source_payroll_record_id,
    source_schedule_snapshot_id,
    employee_id,
    prepaid_minutes,
    settled_minutes,
    prepaid_version,
    correction_of_id,
    effective_work_date,
    effective_shift_start,
    effective_shift_end,
    effective_timezone,
    correction_reason,
    corrected_by,
    corrected_at,
    voided_at,
    voided_by,
    void_reason,
    created_by,
    created_at,
    updated_at
  )
  values (
    v_old.source_payroll_record_id,
    v_old.source_schedule_snapshot_id,
    v_old.employee_id,
    v_minutes,
    0,
    v_old.prepaid_version + 1,
    v_old.id,
    p_work_date,
    v_shift_start,
    v_shift_end,
    v_timezone,
    v_reason,
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    v_actor_user_id,
    'Pending audited prepaid correction version.',
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  )
  returning id into v_new_id;$insert$
  );

  v_updated := replace(
    v_updated,
    $supersede$  update public.payroll_prepaid_hours
  set
    voided_at = pg_catalog.statement_timestamp(),
    voided_by = v_actor_user_id,
    void_reason = 'Superseded by audited prepaid correction ' || v_new_id::text || '.',
    superseded_by_id = v_new_id
  where id = v_old.id;$supersede$,
    $supersede$
  update public.payroll_prepaid_hours
  set
    voided_at = pg_catalog.statement_timestamp(),
    voided_by = v_actor_user_id,
    void_reason = 'Superseded by audited prepaid correction ' || v_new_id::text || '.',
    superseded_by_id = v_new_id
  where id = v_old.id;

  update public.payroll_prepaid_hours
  set
    voided_at = null,
    voided_by = null,
    void_reason = null
  where id = v_new_id;$supersede$
  );

  -- Use short unique fragments for the staged insert so the rewrite is not
  -- dependent on PostgreSQL's dollar-quoted formatting.
  v_updated := replace(v_updated, '    corrected_at,' || chr(10) || '    created_by,', '    corrected_at,' || chr(10) || '    voided_at,' || chr(10) || '    voided_by,' || chr(10) || '    void_reason,' || chr(10) || '    created_by,');
  v_updated := replace(v_updated, '    v_reason,' || chr(10) || '    v_actor_user_id,' || chr(10) || '    pg_catalog.statement_timestamp(),' || chr(10) || '    v_actor_user_id,' || chr(10) || '    pg_catalog.statement_timestamp(),' || chr(10) || '    pg_catalog.statement_timestamp()' || chr(10) || '  )' || chr(10) || '  returning id into v_new_id;', '    v_reason,' || chr(10) || '    v_actor_user_id,' || chr(10) || '    pg_catalog.statement_timestamp(),' || chr(10) || '    pg_catalog.statement_timestamp(),' || chr(10) || '    v_actor_user_id,' || chr(10) || '    ''Pending audited prepaid correction version.'',' || chr(10) || '    v_actor_user_id,' || chr(10) || '    pg_catalog.statement_timestamp(),' || chr(10) || '    pg_catalog.statement_timestamp()' || chr(10) || '  )' || chr(10) || '  returning id into v_new_id;');
  v_updated := replace(v_updated, '  where id = v_old.id;', '  where id = v_old.id;' || chr(10) || chr(10) || '  update public.payroll_prepaid_hours' || chr(10) || '  set' || chr(10) || '    voided_at = null,' || chr(10) || '    voided_by = null,' || chr(10) || '    void_reason = null' || chr(10) || '  where id = v_new_id;');

  if v_updated = v_definition then
    raise exception 'payroll_correct_prepaid_hours hardening rewrite did not apply';
  end if;

  if position('v_profile public.profiles%rowtype;' in v_updated) = 0
     or position('A source schedule is required for the corrected prepaid work date.' in v_updated) = 0
     or position('Pending audited prepaid correction version.' in v_updated) = 0
     or position('voided_at = null' in v_updated) = 0 then
    raise exception 'payroll_correct_prepaid_hours hardening rewrite did not apply';
  end if;

  execute v_updated;
end;
$$;

-- Employee self-service balances use the active effective values. Existing
-- auth, result shape, and non-voided/open-balance restrictions are preserved.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_list_my_prepaid_balances()'::regprocedure
  ), chr(13), '');
  if position('snapshot.work_date' in v_definition) = 0
     or position('prepaid.voided_at is null' in v_definition) = 0 then
    raise exception 'workforce_list_my_prepaid_balances live definition is not the expected version';
  end if;
  v_updated := replace(v_definition, '    snapshot.work_date,', '    coalesce(prepaid.effective_work_date, snapshot.work_date),');
  v_updated := replace(v_updated, '    snapshot.shift_start,', '    coalesce(prepaid.effective_shift_start, snapshot.shift_start),');
  v_updated := replace(v_updated, '    snapshot.shift_end,', '    coalesce(prepaid.effective_shift_end, snapshot.shift_end),');
  v_updated := replace(v_updated, '    snapshot.timezone,', '    coalesce(prepaid.effective_timezone, snapshot.timezone),');
  v_updated := replace(v_updated, '  order by snapshot.work_date, snapshot.shift_start, prepaid.created_at;', '  order by coalesce(prepaid.effective_work_date, snapshot.work_date), coalesce(prepaid.effective_shift_start, snapshot.shift_start), prepaid.created_at;');
  if position('coalesce(prepaid.effective_work_date, snapshot.work_date)' in v_updated) = 0
     or position('coalesce(prepaid.effective_shift_end, snapshot.shift_end)' in v_updated) = 0 then
    raise exception 'workforce_list_my_prepaid_balances correction rewrite did not apply';
  end if;
  execute v_updated;
end;
$$;

-- Attendance Log keeps ordinary attendance behavior unchanged; only its
-- prepaid union uses effective values and the effective date for filtering.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_list_my_attendance_log(date,date)'::regprocedure
  ), chr(13), '');
  if position('snapshot.work_date,' in v_definition) = 0
     or position('snapshot.shift_start as schedule_start' in v_definition) = 0
     or position('and snapshot.work_date between p_start_date and p_end_date' in v_definition) = 0 then
    raise exception 'workforce_list_my_attendance_log live definition is not the expected version';
  end if;
  v_updated := replace(v_definition, '      snapshot.work_date,' || chr(10), '      coalesce(prepaid.effective_work_date, snapshot.work_date),' || chr(10));
  v_updated := replace(v_updated, '      snapshot.shift_start as schedule_start,', '      coalesce(prepaid.effective_shift_start, snapshot.shift_start) as schedule_start,');
  v_updated := replace(v_updated, '      snapshot.shift_end as schedule_end,', '      coalesce(prepaid.effective_shift_end, snapshot.shift_end) as schedule_end,');
  v_updated := replace(v_updated, '      snapshot.timezone as schedule_timezone,', '      coalesce(prepaid.effective_timezone, snapshot.timezone) as schedule_timezone,');
  v_updated := replace(v_updated, '      and snapshot.work_date between p_start_date and p_end_date', '      and coalesce(prepaid.effective_work_date, snapshot.work_date) between p_start_date and p_end_date');
  v_updated := replace(v_updated, '          and attendance_row.work_date = snapshot.work_date', '          and attendance_row.work_date = coalesce(prepaid.effective_work_date, snapshot.work_date)');
  if position('coalesce(prepaid.effective_work_date, snapshot.work_date)' in v_updated) = 0
     or position('coalesce(prepaid.effective_shift_end, snapshot.shift_end)' in v_updated) = 0 then
    raise exception 'workforce_list_my_attendance_log correction rewrite did not apply';
  end if;
  execute v_updated;
end;
$$;

-- Admin Assist preserves its authorization and attendance payload; its
-- prepaid_balances JSON projection is made effective/current only.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_admin_assist_snapshot(uuid,date,date)'::regprocedure
  ), chr(13), '');
  if position($old$'work_date', snapshot.work_date$old$ in v_definition) = 0
     or position($old$'prepaid_clock_in', snapshot.shift_start$old$ in v_definition) = 0
     or position('snapshot.work_date between p_start_date and p_end_date' in v_definition) = 0 then
    raise exception 'workforce_admin_assist_snapshot live definition is not the expected version';
  end if;
  v_updated := replace(v_definition, $old$'work_date', snapshot.work_date$old$, $new$'work_date', coalesce(prepaid.effective_work_date, snapshot.work_date)$new$);
  v_updated := replace(v_updated, $old$'prepaid_clock_in', snapshot.shift_start$old$, $new$'prepaid_clock_in', coalesce(prepaid.effective_shift_start, snapshot.shift_start)$new$);
  v_updated := replace(v_updated, $old$'prepaid_clock_out', snapshot.shift_end$old$, $new$'prepaid_clock_out', coalesce(prepaid.effective_shift_end, snapshot.shift_end)$new$);
  v_updated := replace(v_updated, $old$'timezone', snapshot.timezone$old$, $new$'timezone', coalesce(prepaid.effective_timezone, snapshot.timezone)$new$);
  v_updated := replace(v_updated, 'order by snapshot.work_date desc, snapshot.shift_start desc nulls last', 'order by coalesce(prepaid.effective_work_date, snapshot.work_date) desc, coalesce(prepaid.effective_shift_start, snapshot.shift_start) desc nulls last');
  v_updated := replace(v_updated, 'and snapshot.work_date between p_start_date and p_end_date', 'and coalesce(prepaid.effective_work_date, snapshot.work_date) between p_start_date and p_end_date');
  if position($old$'work_date', coalesce(prepaid.effective_work_date, snapshot.work_date)$old$ in v_updated) = 0
     or position($old$'prepaid_clock_out', coalesce(prepaid.effective_shift_end, snapshot.shift_end)$old$ in v_updated) = 0 then
    raise exception 'workforce_admin_assist_snapshot correction rewrite did not apply';
  end if;
  execute v_updated;
end;
$$;

comment on index payroll_prepaid_hours_one_active_version_idx is
  'Ensures only one non-voided prepaid correction version exists per immutable source snapshot.';

commit;
