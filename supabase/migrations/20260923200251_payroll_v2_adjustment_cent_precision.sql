-- The adjustment amount is stored to cents; reject values that round to zero.
do $patch$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_v2_add_employee_adjustment(uuid,uuid,text,text,numeric)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(v_definition, 'p_amount <= 0') = 0 then
    raise exception 'Payroll V2 adjustment amount validation anchor not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, 'p_amount <= 0', 'round(p_amount, 2) <= 0');
  execute v_definition;
end;
$patch$;

;
