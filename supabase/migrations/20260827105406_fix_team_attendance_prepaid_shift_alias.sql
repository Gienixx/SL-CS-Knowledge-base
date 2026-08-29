-- The admin Team Attendance prepaid RPC reads the effective shift values from
-- a lateral derived row named source_prepaid.  The correction migration that
-- introduced effective prepaid schedules replaced the source expressions with
-- COALESCE expressions but did not preserve their output names.  Keep the
-- canonical effective values and restore the derived-row aliases used by the
-- outer projection.

begin;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_list_team_attendance_prepaid(date,date)'::regprocedure
  ), chr(13), '');

  if position('source_prepaid.shift_start' in v_definition) = 0
     or position('source_prepaid.shift_end' in v_definition) = 0
     or position('coalesce(prepaid.effective_shift_start, snapshot.shift_start),' in v_definition) = 0
     or position('coalesce(prepaid.effective_shift_end, snapshot.shift_end),' in v_definition) = 0 then
    raise exception 'workforce_list_team_attendance_prepaid live definition is not the expected version';
  end if;

  v_updated := replace(
    v_definition,
    '      coalesce(prepaid.effective_shift_start, snapshot.shift_start),',
    '      coalesce(prepaid.effective_shift_start, snapshot.shift_start) as shift_start,'
  );
  v_updated := replace(
    v_updated,
    '      coalesce(prepaid.effective_shift_end, snapshot.shift_end),',
    '      coalesce(prepaid.effective_shift_end, snapshot.shift_end) as shift_end,'
  );

  if v_updated = v_definition
     or position('coalesce(prepaid.effective_shift_start, snapshot.shift_start) as shift_start' in v_updated) = 0
     or position('coalesce(prepaid.effective_shift_end, snapshot.shift_end) as shift_end' in v_updated) = 0 then
    raise exception 'workforce_list_team_attendance_prepaid shift alias rewrite did not apply';
  end if;

  execute v_updated;
end;
$$;

commit;
