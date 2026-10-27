-- Harden persisted-snapshot validation so a missing JSON field cannot pass
-- approval because SQL's three-valued comparison returned NULL.
do $patch$
declare
  v_definition text;
  v_pair text[];
  v_pairs text[][] := array[
    array[$old$jsonb_typeof(v_record.calculation_snapshot) <> 'object'$old$, $new$jsonb_typeof(v_record.calculation_snapshot) is distinct from 'object'$new$],
    array[$old$v_record.calculation_snapshot ->> 'ready_to_preview' <> 'true'$old$, $new$v_record.calculation_snapshot ->> 'ready_to_preview' is distinct from 'true'$new$],
    array[$old$v_record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
          <> v_record.employee_user_id::text$old$, $new$v_record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
          is distinct from v_record.employee_user_id::text$new$],
    array[$old$v_record.calculation_snapshot -> 'period' ->> 'period_id'
          <> v_record.payroll_v2_period_id::text$old$, $new$v_record.calculation_snapshot -> 'period' ->> 'period_id'
          is distinct from v_record.payroll_v2_period_id::text$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'daily_breakdown') <> 'array'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'daily_breakdown') is distinct from 'array'$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'total_payable_minutes') <> 'number'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'total_payable_minutes') is distinct from 'number'$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'attendance_earnings') <> 'number'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'attendance_earnings') is distinct from 'number'$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'paid_leave_earnings') <> 'number'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'paid_leave_earnings') is distinct from 'number'$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'gross_pay') <> 'number'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'gross_pay') is distinct from 'number'$new$],
    array[$old$jsonb_typeof(v_record.calculation_snapshot -> 'net_pay') <> 'number'$old$, $new$jsonb_typeof(v_record.calculation_snapshot -> 'net_pay') is distinct from 'number'$new$]
  ];
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_v2_approve_employee(uuid)'::regprocedure
  ) into v_definition;
  foreach v_pair slice 1 in array v_pairs loop
    if pg_catalog.strpos(v_definition, v_pair[1]) = 0 then
      raise exception 'Expected approval snapshot guard was not found: %', v_pair[1];
    end if;
    v_definition := pg_catalog.replace(v_definition, v_pair[1], v_pair[2]);
  end loop;
  execute v_definition;
end;
$patch$;;
