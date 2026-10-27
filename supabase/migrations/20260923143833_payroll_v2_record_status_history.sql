-- Voided V2 employee records remain part of V2 history and their persisted
-- status must be displayed just like other V2 records.
do $patch$
declare
  v_signature text;
  v_definition text;
  v_old text := $old$and record.status <> 'void'$old$;
begin
  foreach v_signature in array array[
    'public.payroll_v2_get_individual_payslip_data(uuid,uuid)',
    'public.payroll_v2_list_periods()'
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature::regprocedure)
    into v_definition;

    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'Expected V2 active-record-only status/count filter was not found in %.', v_signature;
    end if;

    v_definition := pg_catalog.replace(v_definition, v_old, '');
    execute v_definition;
  end loop;
end;
$patch$;

;
