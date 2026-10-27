-- Activate prior-cutoff Committed Hours deductions for target periods that
-- include October 1, 2026. Earlier targets stay grandfathered; the immediately
-- preceding non-void period may be a September source cutoff.
do $patch$
declare
  v_definition text;
  v_old_target_gate text := $old$if not found or v_current.status = 'void' or v_current.period_start < date '2026-10-06' then$old$;
  v_new_target_gate text := $new$if not found or v_current.status = 'void' or v_current.period_end < date '2026-10-01' then$new$;
  v_old_source_gate text := $old$    and period.period_start >= date '2026-10-06'
$old$;
begin
  v_definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef('public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid)'::regprocedure),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_target_gate) = 0
     or pg_catalog.strpos(v_definition, v_old_source_gate) = 0 then
    raise exception 'Committed Hours cutoff boundary changed; effective-boundary patch aborted.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_target_gate, v_new_target_gate);
  v_definition := pg_catalog.replace(v_definition, v_old_source_gate, '');

  if pg_catalog.strpos(v_definition, v_old_target_gate) > 0
     or pg_catalog.strpos(v_definition, v_old_source_gate) > 0
     or pg_catalog.strpos(v_definition, v_new_target_gate) = 0
     or pg_catalog.strpos(v_definition, 'and period.period_end < v_current.period_start') = 0 then
    raise exception 'Committed Hours cutoff effective-boundary patch failed verification.';
  end if;

  execute v_definition;
end;
$patch$;

;
