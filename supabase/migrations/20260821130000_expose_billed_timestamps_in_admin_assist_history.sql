-- Extend the existing Admin Assist history snapshot with the immutable and
-- billed attendance timestamps already persisted on public.attendance.
-- The live function definition is preserved so authorization and query
-- behavior remain unchanged; this migration only adds history fields.

begin;

do $migration$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_admin_assist_snapshot(uuid,date,date)'::regprocedure),
    chr(13),
    ''
  );

  -- Make the migration safe to re-run after a partially applied deployment.
  if position('attendance_row.original_clock_in' in v_definition) > 0
     and position('attendance_row.original_clock_out' in v_definition) > 0
     and position('attendance_row.billed_clock_in' in v_definition) > 0
     and position('attendance_row.billed_clock_out' in v_definition) > 0 then
    return;
  end if;

  v_updated := replace(
    v_definition,
    $history$
          attendance_row.clock_in,
          attendance_row.clock_out,
          attendance_row.attendance_status,
    $history$,
    $history$
          attendance_row.clock_in,
          attendance_row.clock_out,
          attendance_row.original_clock_in,
          attendance_row.original_clock_out,
          attendance_row.billed_clock_in,
          attendance_row.billed_clock_out,
          attendance_row.attendance_status,
    $history$
  );

  if v_updated = v_definition then
    raise exception 'Admin Assist snapshot history timestamp contract was not found.';
  end if;

  execute v_updated;
end;
$migration$;

commit;
