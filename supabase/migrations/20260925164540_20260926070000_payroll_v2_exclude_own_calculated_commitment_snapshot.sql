-- A calculated Payroll V2 row reserves its committed minutes for other
-- periods, but must not subtract its own snapshot when that same period is
-- previewed or recalculated. Approved and Finalized rows remain protected.
do $patch$
declare
  v_definition text;
  v_old text := $old$and record.status <> 'void'
        union all$old$;
  v_new text := $new$and record.status <> 'void'
          and not (
            record.status = 'calculated'
            and exists (
              select 1
              from public.payroll_v2_periods current_period
              where current_period.id = record.payroll_v2_period_id
                and current_period.period_start = p_start_date
                and current_period.period_end = p_end_date
            )
          )
        union all$new$;
  v_match_count integer;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_get_expected_committed_hours_summary(uuid, date, date)'::regprocedure
    ),
    chr(13),
    ''
  );

  v_match_count := (
    length(v_definition)
    - length(pg_catalog.replace(v_definition, v_old, ''))
  ) / length(v_old);
  if v_match_count <> 1 then
    raise exception 'Committed Hours V2 paid-snapshot query changed; self-snapshot patch aborted.';
  end if;

  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;

;
