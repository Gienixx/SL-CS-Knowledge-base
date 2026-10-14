-- Preserve the conversion RPC's implementation, signature, security settings,
-- ACL, and all validation. Only allow an active administrator through the same
-- authorization gate used for ordinary self-service schedule requests.
do $migration$
declare
  v_function_oid oid;
  v_source text;
  v_normalized_source text;
  v_definition text;
  v_old_guard constant text := $old$or not public.workforce_current_user_is_agent() then$old$;
  v_new_guard constant text := $new$or not (public.workforce_current_user_is_agent() or public.workforce_is_admin()) then$new$;
  v_new_guard_normalized constant text := 'or not (public.workforce_current_user_is_agent() or public.workforce_is_admin()) then';
  v_old_message constant text := $old$Authentication and an active workforce agent profile are required.$old$;
  v_new_message constant text := $new$Authentication and an active workforce agent or administrator profile are required.$new$;
begin
  select function_row.oid, function_row.prosrc
  into v_function_oid, v_source
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'public'
    and function_row.proname = 'workforce_submit_schedule_conversion_request'
    and pg_catalog.pg_get_function_identity_arguments(function_row.oid) =
      'p_request_type text, p_work_date date, p_target_schedule_id uuid, p_requested_shift_start timestamp with time zone, p_requested_shift_end timestamp with time zone, p_reason text';

  if v_function_oid is null then
    raise exception 'Expected schedule conversion RPC is missing.';
  end if;

  v_normalized_source := pg_catalog.regexp_replace(v_source, E'\\s+', ' ', 'g');
  if pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_guard, ''))
       = pg_catalog.length(v_old_guard)
     and pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_message, ''))
       = pg_catalog.length(v_old_message) then
    v_definition := pg_catalog.pg_get_functiondef(v_function_oid);
    v_definition := pg_catalog.replace(v_definition, v_old_guard, v_new_guard);
    v_definition := pg_catalog.replace(v_definition, v_old_message, v_new_message);
    execute v_definition;
  elsif pg_catalog.strpos(v_normalized_source, v_new_guard_normalized) > 0
        and pg_catalog.strpos(v_source, v_new_message) > 0 then
    null;
  else
    raise exception 'Schedule conversion authorization differs from the verified baseline; no function was changed.';
  end if;
end;
$migration$;
