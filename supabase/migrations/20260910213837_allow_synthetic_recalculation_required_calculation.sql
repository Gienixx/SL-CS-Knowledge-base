-- A controlled reopen marks each payroll record as requiring recalculation.
-- That record-level marker is the work the calculator is supposed to clear;
-- it must not block calculation. Real source/attendance exceptions remain
-- blocking, and review/finalization continue to use the full exception set.

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
  where issue.is_blocking
    and (
      p_payroll_record_id is null
$old$;
  v_new := $new$
  where issue.is_blocking
    and not (
      issue.exception_code = 'changed_attendance_after_import'
      and issue.attendance_id is null
      and coalesce((issue.details ->> 'requires_recalculation')::boolean, false)
    )
    and (
      p_payroll_record_id is null
$new$;

  if position(v_old in v_definition) = 0 then
    raise exception 'Expected calculation blocker predicate was not found.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;

comment on function public.payroll_calculate_draft_for_record(uuid,uuid) is
  'Calculates draft payroll; synthetic record-level recalculation-required markers do not block calculation, while real source exceptions remain blocking.';;
