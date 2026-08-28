begin;

-- Payroll snapshots require canonical clock timestamps. A manager may leave
-- billed timestamps null when no billed correction is needed, so the import
-- must fall back to the captured attendance timestamps while preserving the
-- nullable billed values separately for audit and payroll display.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef(
      'public.payroll_import_attendance(uuid,uuid)'::regprocedure
    ),
    chr(13),
    ''
  );

  v_updated := replace(
    v_definition,
    '      attendance_row.work_date,' || chr(10)
      || '      attendance_row.billed_clock_in as billed_clock_in,' || chr(10)
      || '      attendance_row.billed_clock_out as billed_clock_out,',
    '      attendance_row.work_date,' || chr(10)
      || '      attendance_row.clock_in as captured_clock_in,' || chr(10)
      || '      attendance_row.clock_out as captured_clock_out,' || chr(10)
      || '      attendance_row.billed_clock_in as billed_clock_in,' || chr(10)
      || '      attendance_row.billed_clock_out as billed_clock_out,'
  );

  v_updated := replace(
    v_updated,
    '      source.work_date,' || chr(10)
      || '      source.billed_clock_in,' || chr(10)
      || '      source.billed_clock_out,' || chr(10)
      || '      source.billed_clock_in,' || chr(10)
      || '      source.billed_clock_out,',
    '      source.work_date,' || chr(10)
      || '      coalesce(source.billed_clock_in, source.captured_clock_in),' || chr(10)
      || '      coalesce(source.billed_clock_out, source.captured_clock_out),' || chr(10)
      || '      source.billed_clock_in,' || chr(10)
      || '      source.billed_clock_out,'
  );

  if v_updated = v_definition
     or position('attendance_row.clock_in as captured_clock_in' in v_updated) = 0
     or position('attendance_row.clock_out as captured_clock_out' in v_updated) = 0
     or position('coalesce(source.billed_clock_in, source.captured_clock_in)' in v_updated) = 0
     or position('coalesce(source.billed_clock_out, source.captured_clock_out)' in v_updated) = 0 then
    raise exception
      'payroll_import_attendance did not contain the expected nullable billed timestamp import shape';
  end if;

  execute v_updated;
end;
$$;

comment on function public.payroll_import_attendance(uuid,uuid) is
  'Imports payroll-ready attendance using billed timestamps when present and captured timestamps otherwise.';

-- Keep the reconciliation trigger safe even if a privileged caller attempts
-- to insert a payroll snapshot outside the normal readiness/import RPC. An
-- unapproved snapshot must never consume a prepaid balance or block the later
-- approved import with a duplicate snapshot version.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef(
      'public.payroll_reconcile_prepaid_hours()'::regprocedure
    ),
    chr(13),
    ''
  );

  v_updated := replace(
    v_definition,
    '  v_calculation_version integer;' || chr(10),
    '  v_calculation_version integer;' || chr(10)
      || '  v_attendance public.attendance%rowtype;' || chr(10)
  );

  v_updated := replace(
    v_updated,
    '  v_calculation_version := new.attendance_version::integer;' || chr(10),
    '  v_calculation_version := new.attendance_version::integer;' || chr(10)
      || chr(10)
      || '  select attendance_row.*' || chr(10)
      || '  into v_attendance' || chr(10)
      || '  from public.attendance as attendance_row' || chr(10)
      || '  where attendance_row.id = new.attendance_id' || chr(10)
      || '    and attendance_row.attendance_version = new.attendance_version' || chr(10)
      || '    and attendance_row.voided_at is null' || chr(10)
      || '  for share;' || chr(10)
      || chr(10)
      || '  if not found' || chr(10)
      || '     or v_attendance.review_status not in (''approved'', ''locked'') then' || chr(10)
      || '    raise exception' || chr(10)
      || '      using' || chr(10)
      || '        errcode = ''42501'',' || chr(10)
      || '        message = ''Only approved or locked attendance can reconcile prepaid hours.'';' || chr(10)
      || '  end if;' || chr(10)
  );

  if v_updated = v_definition
     or position('v_attendance public.attendance%rowtype;' in v_updated) = 0
     or position('v_attendance.review_status not in (''approved'', ''locked'')' in v_updated) = 0 then
    raise exception
      'payroll_reconcile_prepaid_hours did not contain the expected attendance approval guard';
  end if;

  execute v_updated;
end;
$$;

comment on function public.payroll_reconcile_prepaid_hours() is
  'Reconciles only approved or locked ordinary attendance, using canonical snapshot minutes and FIFO prepaid balances.';

commit;
