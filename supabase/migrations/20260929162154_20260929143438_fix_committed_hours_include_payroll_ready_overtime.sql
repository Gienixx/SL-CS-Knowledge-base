-- Keep the canonical FIFO helper intact and change only how each ready
-- attendance row contributes eligible minutes. pg_get_functiondef preserves
-- the installed helper's current body and security attributes; the guarded
-- replacement fails closed if Production has drifted from the reviewed source.
do $migration$
declare
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.payroll_get_expected_committed_hours_summary(uuid,date,date)'
  );
  v_definition text;
  v_old_expression text := $old$
        'eligible_minutes', case
          when public.payroll_expected_commitment_day_type(p_employee_user_id, readiness.work_date) = 'rest_day'
            then greatest(coalesce(readiness.rest_day_overtime_minutes, 0), 0)
          else greatest(coalesce(readiness.regular_minutes, 0), 0)
        end::integer
$old$;
  v_new_expression text := $new$
        'eligible_minutes', (
          greatest(coalesce(readiness.regular_minutes, 0), 0)
          + greatest(coalesce(readiness.total_overtime_minutes, 0), 0)
        )::integer
$new$;
  v_old_count integer;
  v_new_count integer;
begin
  if v_function is null then
    raise exception 'Canonical Committed Hours helper was not found; refusing to install an unreviewed replacement.';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_old_count := (
    length(v_definition) - length(replace(v_definition, v_old_expression, ''))
  ) / length(v_old_expression);
  v_new_count := (
    length(v_definition) - length(replace(v_definition, v_new_expression, ''))
  ) / length(v_new_expression);

  if v_old_count = 0 and v_new_count = 1 then
    -- Already corrected; this makes the migration safe to replay.
    null;
  elsif v_old_count = 1 and v_new_count = 0 then
    execute replace(v_definition, v_old_expression, v_new_expression);
  else
    raise exception 'Canonical Committed Hours helper differs from the reviewed version; refusing to overwrite it.';
  end if;
end;
$migration$;

;
