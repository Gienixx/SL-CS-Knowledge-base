-- Keep incomplete attendance out of WORKED earnings without blocking other
-- determinable V2 inputs such as payable Committed Hours or paid leave.
do $patch$
declare
  v_definition text;
  v_old_comment text := $old$  -- Any source readiness blocker blocks the monetary preview. Preserve the
  -- work date, blocker code, and all source attendance IDs for review.$old$;
  v_new_comment text := $new$  -- Keep attendance blockers visible for review. Unready attendance stays out
  -- of WORKED earnings; rate blockers still prevent calculations that cannot be priced.$new$;
  v_old text := 'v_ready := jsonb_array_length(v_blockers) = 0;';
  v_new text := 'v_ready := jsonb_array_length(v_rate_blockers) = 0;';
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_v2_employee_calculation_payload(uuid, uuid)'::regprocedure
    ),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_comment) = 0 then
    raise exception 'Payroll V2 readiness comment changed; partial-input patch aborted.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old_comment, v_new_comment);

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 readiness gate changed; partial-input patch aborted.';
  end if;

  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;;
