begin;

alter table public.workforce_audit_logs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create or replace function public.workforce_audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_entity_id uuid;
  v_actor uuid;
  v_reason text;
  v_metadata jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    v_before := null;
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
    v_after := null;
  end if;

  v_entity_id := nullif(coalesce(v_after, v_before) ->> tg_argv[0], '')::uuid;

  v_actor := coalesce(
    auth.uid(),
    nullif(v_after ->> 'updated_by', '')::uuid,
    nullif(v_after ->> 'corrected_by', '')::uuid,
    nullif(v_after ->> 'reviewed_by', '')::uuid,
    nullif(v_after ->> 'created_by', '')::uuid
  );

  v_reason := coalesce(
    nullif(v_after ->> 'correction_reason', ''),
    nullif(v_after ->> 'review_notes', ''),
    nullif(v_after ->> 'reason', '')
  );

  if tg_table_name = 'attendance'
     and tg_op = 'UPDATE'
     and (v_before ->> 'clock_out') is null
     and (v_after ->> 'clock_out') is not null then
    v_metadata := coalesce(
      nullif(current_setting('workforce.clock_out_provenance', true), '')::jsonb,
      '{}'::jsonb
    );
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id,
    before_data, after_data, reason, metadata
  ) values (
    v_actor, lower(tg_op), tg_table_name, v_entity_id,
    v_before, v_after, v_reason, v_metadata
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Keep one PostgREST-visible function signature. Having both a zero-argument
-- function and a defaulted overload makes legacy REST calls ambiguous.
drop function if exists public.workforce_clock_out();

create or replace function public.workforce_clock_out(
  p_action_source text default 'unknown',
  p_client_request_id uuid default null,
  p_page_session_id uuid default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_clock_time timestamptz := now();
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();
  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select attendance_row.* into v_existing
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
  order by attendance_row.clock_in desc
  limit 1
  for update;

  if not found then raise exception 'No open attendance record was found.'; end if;
  if v_clock_time < v_existing.clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  perform set_config(
    'workforce.clock_out_provenance',
    jsonb_build_object(
      'attendance_uuid', v_existing.id,
      'authenticated_user_id', v_auth_user_id,
      'action_source', coalesce(nullif(trim(p_action_source), ''), 'unknown'),
      'client_request_id', p_client_request_id,
      'page_session_id', p_page_session_id,
      'timestamp', v_clock_time
    )::text,
    true
  );

  update public.attendance
  set clock_out = v_clock_time,
      pre_shift_overtime_minutes = null,
      regular_minutes = null,
      post_shift_overtime_minutes = null,
      rest_day_overtime_minutes = 0,
      holiday_overtime_minutes = 0,
      total_overtime_minutes = 0,
      overtime_minutes = 0,
      minutes_late = 0,
      is_late = false,
      undertime_minutes = 0,
      updated_by = v_auth_user_id
  where id = v_existing.id
  returning * into v_result;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

-- The defaulted parameters preserve legacy zero-argument SQL/REST callers;
-- they are recorded as unknown source.
revoke all on function public.workforce_clock_out(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.workforce_clock_out(text, uuid, uuid) to authenticated, service_role;

-- Admin Assist remains server-labelled and uses the same audit trigger metadata.
create or replace function public.workforce_admin_assist_clock_out(
  p_target_user_id uuid,
  p_reason text
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;
  if p_target_user_id is null or length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Target employee and reason are required for Admin Assist.';
  end if;
  select * into v_existing from public.attendance
  where user_id = p_target_user_id and clock_in is not null and clock_out is null
  order by clock_in desc limit 1 for update;
  if not found then raise exception 'No open attendance record was found for the target employee.'; end if;

  perform set_config('workforce.clock_out_provenance', jsonb_build_object(
    'attendance_uuid', v_existing.id,
    'authenticated_user_id', v_actor,
    'action_source', 'admin_assist',
    'timestamp', now()
  )::text, true);

  update public.attendance set clock_out = now(), updated_by = v_actor
  where id = v_existing.id returning * into v_result;
  v_result := public.workforce_recalculate_attendance(v_result.id);
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (v_actor, 'admin_assisted_clock_out', 'attendance', v_result.id, to_jsonb(v_existing),
    jsonb_build_object('target_employee_id', p_target_user_id, 'action', 'clock-out', 'timestamp', v_result.clock_out, 'audit_source', 'admin_assisted_clock_out'), trim(p_reason));
  return v_result;
end;
$$;

commit;
