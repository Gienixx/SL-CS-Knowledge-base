-- Correct the production-forward void filter so it applies only to attendance
-- rows, not to the profiles lookup used by Admin Assist.

begin;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := replace(
    pg_get_functiondef('public.workforce_admin_assist_snapshot(uuid,date,date)'::regprocedure),
    chr(13),
    ''
  );
  v_updated := replace(
    v_definition,
    'where user_id = p_target_user_id
      and voided_at is null
    and is_agent is true',
    'where user_id = p_target_user_id
    and is_agent is true'
  );
  if v_updated = v_definition then
    raise exception 'Admin Assist snapshot profile predicate was not found for correction';
  end if;
  execute v_updated;
end;
$$;

commit;
