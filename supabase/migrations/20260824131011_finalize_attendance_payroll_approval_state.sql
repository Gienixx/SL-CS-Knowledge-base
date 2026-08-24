-- Finalize independent payroll approval state without changing review/lock
-- semantics.

begin;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_recalculate_attendance(uuid)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    E'  v_result public.attendance%rowtype;\n',
    E'  v_result public.attendance%rowtype;\n  v_payroll_calculation_changed boolean;\n'
  );
  v_updated := replace(
    v_updated,
    '  v_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);',
    E'  if v_attendance.review_status = ''locked'' then\n    raise exception ''Locked attendance cannot be recalculated.'';\n  end if;\n\n  v_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);'
  );
  v_updated := replace(
    v_updated,
    E'  update public.attendance set\n    pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,',
    E'  v_payroll_calculation_changed :=\n    v_attendance.pre_shift_overtime_minutes is distinct from v_calculation.pre_shift_overtime_minutes\n    or v_attendance.regular_minutes is distinct from v_calculation.regular_minutes\n    or v_attendance.post_shift_overtime_minutes is distinct from v_calculation.post_shift_overtime_minutes\n    or v_attendance.rest_day_overtime_minutes is distinct from v_calculation.rest_day_overtime_minutes\n    or v_attendance.holiday_overtime_minutes is distinct from v_calculation.holiday_overtime_minutes\n    or v_attendance.total_overtime_minutes is distinct from v_calculation.total_overtime_minutes\n    or v_attendance.overtime_minutes is distinct from v_calculation.total_overtime_minutes\n    or v_attendance.total_worked_minutes is distinct from v_calculation.total_worked_minutes\n    or v_attendance.minutes_late is distinct from v_calculation.minutes_late\n    or v_attendance.is_late is distinct from (v_calculation.minutes_late > 0)\n    or v_attendance.undertime_minutes is distinct from v_calculation.undertime_minutes;\n\n  update public.attendance set\n    review_status = case\n      when v_payroll_calculation_changed\n       and v_attendance.payroll_approved_at is not null\n       and v_attendance.review_status = ''approved''\n        then ''corrected''\n      else v_attendance.review_status\n    end,\n    payroll_approved_at = case\n      when v_payroll_calculation_changed\n       and v_attendance.payroll_approved_at is not null\n        then null\n      else v_attendance.payroll_approved_at\n    end,\n    pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,'
  );

  if v_updated = v_definition
     or position('v_payroll_calculation_changed boolean' in v_updated) = 0
     or position('Locked attendance cannot be recalculated.' in v_updated) = 0
     or position('payroll_approved_at = case' in v_updated) = 0 then
    raise exception 'workforce_recalculate_attendance live definition did not expose the expected anchors';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_recalculate_attendance_work_date(uuid,date)'::regprocedure),
    chr(13), ''
  );
  v_updated := replace(
    v_definition,
    E'    and voided_at is null\n    and schedule_id is not null;',
    E'    and voided_at is null\n    and payroll_approved_at is null\n    and schedule_id is not null;'
  );
  if v_updated = v_definition
     or position('and payroll_approved_at is null' in v_updated) = 0 then
    raise exception 'workforce_recalculate_attendance_work_date live definition did not expose its reset anchor';
  end if;
  execute v_updated;
end;
$$;

-- Schedule edits are payroll-relevant even when the recalculated minute totals
-- happen to remain numerically equal. Invalidate approved linked attendance
-- before the existing recalculation call. Locked rows continue to fail through
-- the existing immutable trigger when the schedule workflow reaches them.
do $$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.workforce_admin_save_schedule(uuid,uuid,date,integer,timestamptz,timestamptz,text,text,boolean,boolean,text,text)',
    'public.workforce_admin_save_open_schedule_without_audit_reason(uuid,uuid,date,integer,text,text,text,integer)'
  ] loop
    v_definition := replace(pg_get_functiondef(v_signature::regprocedure), chr(13), '');
    v_updated := replace(
      v_definition,
      '        perform public.workforce_recalculate_attendance(v_attendance_id);',
      E'        update public.attendance\n        set review_status = case when review_status = ''approved'' then ''corrected'' else review_status end,\n            payroll_approved_at = null\n        where id = v_attendance_id\n          and payroll_approved_at is not null;\n\n        perform public.workforce_recalculate_attendance(v_attendance_id);'
    );
    if v_updated = v_definition then
      raise exception '% live definition did not expose its attendance recalculation call', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$$;

-- Void/restore are operational transitions. They preserve the marker; the
-- recalculation boundary above invalidates only when effective payroll values
-- change after restore or another recalculation caller.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef('public.workforce_delete_attendance(uuid,text)'::regprocedure), chr(13), '');
  if position('payroll_approved_at = null' in v_definition) > 0 then
    raise exception 'Void must not clear payroll approval as a side effect';
  end if;
  v_definition := replace(pg_get_functiondef('public.workforce_restore_attendance(uuid,text)'::regprocedure), chr(13), '');
  if position('payroll_approved_at = null' in v_definition) > 0 then
    raise exception 'Restore must not clear payroll approval as a side effect';
  end if;
end;
$$;

-- Keep every pre-existing attendance column available to authenticated agent
-- workflows while omitting the additive payroll marker from direct Data API
-- reads. The authorized Team Attendance RPC remains the marker boundary.
revoke select on table public.attendance from authenticated;
revoke select (payroll_approved_at) on table public.attendance from authenticated;
grant select (
  id, user_id, schedule_id, work_date, clock_in, clock_out,
  attendance_status, is_late, minutes_late, overtime_minutes, undertime_minutes,
  correction_reason, admin_notes, corrected_by, corrected_at, created_by,
  updated_by, created_at, updated_at, original_clock_in, original_clock_out,
  pre_shift_overtime_minutes, regular_minutes, post_shift_overtime_minutes,
  total_overtime_minutes, total_worked_minutes, is_corrected, review_status,
  reviewed_by, reviewed_at, rest_day_overtime_minutes, holiday_overtime_minutes,
  attendance_version, billed_clock_in, billed_clock_out, voided_at, voided_by,
  void_reason, manager_review_reason
) on table public.attendance to authenticated;

comment on column public.attendance.payroll_approved_at is
  'Timestamp when this attendance entry was last approved for payroll. It survives void/restore when payroll values are unchanged and is cleared when a correction or effective recalculation reopens review.';

commit;
