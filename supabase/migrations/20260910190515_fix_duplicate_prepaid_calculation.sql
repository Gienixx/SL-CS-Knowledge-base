-- A current schedule snapshot created only for recalculation provenance is
-- evidence, not a new prepaid entitlement.  Economic prepaid earnings must
-- come from a live balance with authoritative remaining minutes.

do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_calculate_draft_for_record(uuid,uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$
    prepaid.prepaid_minutes::numeric / 60,
    rate.hourly_rate,
    round(
      prepaid.prepaid_minutes::numeric / 60 * rate.hourly_rate,
      v_money_scale
    ),
$old$;
  v_new := $new$
    greatest(prepaid.remaining_minutes, 0)::numeric / 60,
    rate.hourly_rate,
    round(
      greatest(prepaid.remaining_minutes, 0)::numeric / 60 * rate.hourly_rate,
      v_money_scale
    ),
$new$;

  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid earning amount block was not found.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
    and coalesce(snapshot.source_metadata ->> 'historical_restore', 'false') <> 'true';
$old$;
  v_new := $new$
    and coalesce(snapshot.source_metadata ->> 'historical_restore', 'false') <> 'true'
    and coalesce(snapshot.source_metadata ->> 'recalculation_provenance_only', 'false') <> 'true'
    and prepaid.remaining_minutes > 0
    and prepaid.prepaid_minutes > prepaid.settled_minutes;
$new$;

  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid earning predicate was not found.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;

comment on function public.payroll_calculate_draft_for_record(uuid,uuid) is
  'Calculates draft payroll using current attendance/schedule evidence; prepaid earnings require a non-provenance-only source with positive authoritative remaining minutes.';

;
