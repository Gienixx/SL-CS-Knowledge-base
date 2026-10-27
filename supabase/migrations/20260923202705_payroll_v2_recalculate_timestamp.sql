-- Ensure calculated_at advances even when a calculation RPC is exercised
-- inside a larger transaction (where statement_timestamp is fixed).
do $patch$
declare v_definition text;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_recalculate_employee(uuid,text,text)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, 'v_at timestamptz := statement_timestamp();') = 0
     or pg_catalog.strpos(v_definition, 'calculated_at = v_temporary_record.calculated_at,') = 0 then
    raise exception 'Payroll V2 recalculation timestamp anchors changed; patch aborted.';
  end if;
  v_definition := pg_catalog.replace(v_definition,
    'v_at timestamptz := statement_timestamp();',
    'v_at timestamptz := clock_timestamp();');
  v_definition := pg_catalog.replace(v_definition,
    'calculated_at = v_temporary_record.calculated_at,',
    'calculated_at = greatest(v_temporary_record.calculated_at, v_at),');
  execute v_definition;
end;
$patch$;

;
