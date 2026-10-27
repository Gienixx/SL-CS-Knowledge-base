-- Make readiness independently validate the stored total and the billed
-- classification against the canonical billed duration.
-- This is a forward-only correction; it does not touch attendance data.

begin;
do $$
declare
  v_definition text;
  v_updated text;
  v_old_predicate constant text := $old$attendance_row.total_worked_minutes IS DISTINCT FROM (GREATEST(COALESCE(attendance_row.regular_minutes, 0), 0) + GREATEST(COALESCE(attendance_row.total_overtime_minutes, 0), 0)) AND (GREATEST(COALESCE(attendance_row.regular_minutes, 0), 0) + GREATEST(COALESCE(attendance_row.total_overtime_minutes, 0), 0)) IS DISTINCT FROM workforce_canonical_billed_minutes(COALESCE(attendance_row.billed_clock_in, attendance_row.clock_in), COALESCE(attendance_row.billed_clock_out, attendance_row.clock_out))$old$;
  v_new_predicate constant text := $new$attendance_row.total_worked_minutes IS DISTINCT FROM public.workforce_canonical_billed_minutes(COALESCE(attendance_row.billed_clock_in, attendance_row.clock_in), COALESCE(attendance_row.billed_clock_out, attendance_row.clock_out))$new$;
begin
  v_definition := pg_get_viewdef(
    'public.workforce_attendance_payroll_readiness'::regclass,
    true
  );

  v_updated := replace(v_definition, v_old_predicate, v_new_predicate);

  if v_updated = v_definition
     or position(v_new_predicate in v_updated) = 0
     or position(v_old_predicate in v_updated) > 0 then
    raise exception 'Payroll readiness view did not expose the expected coupled canonical-duration predicate.';
  end if;

  execute 'create or replace view public.workforce_attendance_payroll_readiness with (security_invoker = true) as ' || v_updated;
end;
$$;
commit;
