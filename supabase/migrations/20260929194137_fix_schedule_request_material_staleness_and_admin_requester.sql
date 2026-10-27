begin;

alter table public.leave_requests
  add column if not exists target_schedule_version bigint,
  add column if not exists target_schedule_updated_at timestamptz,
  add column if not exists original_shift_start timestamptz,
  add column if not exists original_shift_end timestamptz,
  add column if not exists original_planned_paid_minutes integer,
  add column if not exists original_schedule_status text;

create or replace function public.workforce_schedule_request_material_state(p_schedule jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $function$
  select case when p_schedule is null then null else jsonb_build_object(
    'id', p_schedule -> 'id',
    'user_id', p_schedule -> 'user_id',
    'work_date', p_schedule -> 'shift_date',
    'sequence', coalesce(nullif(p_schedule ->> 'shift_sequence', '')::integer, 1),
    'timezone', coalesce(nullif(p_schedule ->> 'timezone', ''), 'America/New_York'),
    'start_epoch', case when nullif(p_schedule ->> 'shift_start', '') is null then null
      else extract(epoch from (p_schedule ->> 'shift_start')::timestamptz) end,
    'end_epoch', case when nullif(p_schedule ->> 'shift_end', '') is null then null
      else extract(epoch from (p_schedule ->> 'shift_end')::timestamptz) end,
    'planned_paid_minutes', nullif(p_schedule ->> 'planned_paid_minutes', '')::integer,
    'is_rest_day', coalesce(nullif(p_schedule ->> 'is_rest_day', '')::boolean, false),
    'is_holiday', coalesce(nullif(p_schedule ->> 'is_holiday', '')::boolean, false),
    'is_leave', coalesce(nullif(p_schedule ->> 'is_leave', '')::boolean, false),
    'is_absent', coalesce(nullif(p_schedule ->> 'is_absent', '')::boolean, false),
    'leave_type', p_schedule -> 'leave_type',
    'absence_type', p_schedule -> 'absence_type',
    'cancelled', lower(coalesce(p_schedule ->> 'status', '')) = 'cancelled'
      or coalesce(nullif(p_schedule ->> 'automation_leave_cancelled', '')::boolean, false)
  ) end;
$function$;

revoke all on function public.workforce_schedule_request_material_state(jsonb)
  from public, anon, authenticated;

create or replace function public.workforce_schedule_request_state_internal(
  p_request_id uuid,
  p_lock boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.leave_requests%rowtype;
  v_event record;
  v_baseline jsonb;
  v_current jsonb;
  v_baseline_count integer := 0;
  v_current_count integer := 0;
  v_verified boolean := true;
  v_stale boolean := false;
  v_effective_target_id uuid;
begin
  if p_lock then
    select * into v_request from public.leave_requests where id = p_request_id for update;
  else
    select * into v_request from public.leave_requests where id = p_request_id;
  end if;

  if not found then
    raise exception 'Schedule request not found.';
  end if;
  if v_request.request_category <> 'schedule_change'
     or v_request.request_type not in ('open_schedule', 'slide_shift') then
    return jsonb_build_object('verified', false, 'is_stale', true, 'baseline_schedule', null,
                              'current_schedule', null, 'effective_target_schedule_id', null);
  end if;

  if v_request.target_schedule_id is not null then
    select case when log_row.action = 'delete' then null else log_row.after_data end
      into v_baseline
    from public.workforce_audit_logs log_row
    where log_row.entity_type = 'work_schedules'
      and log_row.entity_id = v_request.target_schedule_id
      and log_row.created_at <= v_request.created_at
    order by log_row.created_at desc, log_row.id desc
    limit 1;

    if not found or v_baseline is null
       or v_baseline ->> 'user_id' is distinct from v_request.user_id::text
       or (v_baseline ->> 'shift_date')::date is distinct from v_request.start_date then
      v_verified := false;
    else
      v_baseline_count := 1;
      v_effective_target_id := v_request.target_schedule_id;
    end if;

    if p_lock then
      select to_jsonb(schedule_row) into v_current
      from public.work_schedules schedule_row
      where schedule_row.id = v_request.target_schedule_id
      for update;
    else
      select to_jsonb(schedule_row) into v_current
      from public.work_schedules schedule_row
      where schedule_row.id = v_request.target_schedule_id;
    end if;
    if v_current is not null then v_current_count := 1; end if;
  else
    for v_event in
      with candidate_ids as (
        select distinct log_row.entity_id
        from public.workforce_audit_logs log_row
        where log_row.entity_type = 'work_schedules'
          and log_row.created_at <= v_request.created_at
          and (
            (log_row.before_data ->> 'user_id' = v_request.user_id::text
              and (log_row.before_data ->> 'shift_date')::date = v_request.start_date)
            or (log_row.after_data ->> 'user_id' = v_request.user_id::text
              and (log_row.after_data ->> 'shift_date')::date = v_request.start_date)
          )
      )
      select latest.action,
             case when latest.action = 'delete' then null else latest.after_data end as schedule_state
      from candidate_ids candidate
      cross join lateral (
        select log_row.action, log_row.after_data
        from public.workforce_audit_logs log_row
        where log_row.entity_type = 'work_schedules'
          and log_row.entity_id = candidate.entity_id
          and log_row.created_at <= v_request.created_at
        order by log_row.created_at desc, log_row.id desc
        limit 1
      ) latest
      where latest.action <> 'delete'
        and latest.after_data ->> 'user_id' = v_request.user_id::text
        and (latest.after_data ->> 'shift_date')::date = v_request.start_date
      order by latest.after_data ->> 'shift_sequence'
    loop
      v_baseline_count := v_baseline_count + 1;
      if v_baseline_count = 1 then
        v_baseline := v_event.schedule_state;
        v_effective_target_id := nullif(v_event.schedule_state ->> 'id', '')::uuid;
      end if;
    end loop;

    if p_lock then
      perform 1 from public.work_schedules schedule_row
      where schedule_row.user_id = v_request.user_id
        and schedule_row.shift_date = v_request.start_date
      for update;
    end if;
    select count(*)::integer into v_current_count
    from public.work_schedules schedule_row
    where schedule_row.user_id = v_request.user_id
      and schedule_row.shift_date = v_request.start_date;
    if v_current_count = 1 then
      select to_jsonb(schedule_row) into v_current
      from public.work_schedules schedule_row
      where schedule_row.user_id = v_request.user_id
        and schedule_row.shift_date = v_request.start_date;
    end if;
  end if;

  if v_baseline_count > 1 or v_current_count > 1 then
    v_verified := false;
  elsif v_verified then
    v_stale := public.workforce_schedule_request_material_state(v_baseline)
      is distinct from public.workforce_schedule_request_material_state(v_current);
  end if;

  return jsonb_build_object(
    'verified', v_verified,
    'is_stale', v_stale or not v_verified,
    'baseline_schedule', v_baseline,
    'current_schedule', v_current,
    'effective_target_schedule_id', v_effective_target_id
  );
end;
$function$;

revoke all on function public.workforce_schedule_request_state_internal(uuid, boolean)
  from public, anon, authenticated;

create or replace function public.workforce_get_schedule_request_freshness(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.leave_requests%rowtype;
  v_state jsonb;
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin() then
    raise exception 'Active administrator access is required.' using errcode = '42501';
  end if;
  select * into v_request from public.leave_requests where id = p_request_id;
  if not found then raise exception 'Schedule request not found.'; end if;
  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave')
     or not public.workforce_can_manage_user(v_request.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to review and apply this schedule request.' using errcode = '42501';
  end if;
  v_state := public.workforce_schedule_request_state_internal(p_request_id, false);
  return v_state;
end;
$function$;

revoke all on function public.workforce_get_schedule_request_freshness(uuid) from public, anon;
grant execute on function public.workforce_get_schedule_request_freshness(uuid) to authenticated, service_role;

create or replace function public.workforce_submit_schedule_request(
  p_request_type text,
  p_work_date date,
  p_target_schedule_id uuid,
  p_requested_shift_start timestamptz,
  p_requested_shift_end timestamptz,
  p_requested_planned_paid_minutes integer,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := public.workforce_current_profile_id();
  v_type text := lower(trim(coalesce(p_request_type, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_target public.work_schedules%rowtype;
  v_target_id uuid := p_target_schedule_id;
  v_schedule_count integer := 0;
  v_profile public.profiles%rowtype;
  v_result public.leave_requests%rowtype;
  v_timezone text := 'America/New_York';
begin
  if auth.uid() is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not (public.workforce_current_user_is_agent() or public.workforce_is_admin()) then
    raise exception 'Authentication and an active workforce agent or administrator profile are required.' using errcode = '42501';
  end if;

  if v_type not in ('open_schedule', 'slide_shift') then
    raise exception 'Select a valid schedule-change request type.';
  end if;
  if p_work_date is null or v_reason is null then
    raise exception 'Work date and request reason are required.';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The request reason cannot exceed 1000 characters.';
  end if;

  select * into v_profile from public.profiles where user_id = v_user_id;
  if not found then raise exception 'Employee profile not found.'; end if;

  if v_target_id is not null then
    select * into v_target
    from public.work_schedules
    where id = v_target_id and user_id = v_user_id
    for update;
    if not found then raise exception 'The selected schedule does not belong to you.'; end if;
    if v_target.shift_date <> p_work_date then
      raise exception 'The selected schedule does not match the requested work date.';
    end if;
  else
    if v_type = 'slide_shift' then
      raise exception 'Slide Shift requires an existing schedule.';
    end if;
    select count(*)::integer into v_schedule_count
    from public.work_schedules schedule_row
    where schedule_row.user_id = v_user_id and schedule_row.shift_date = p_work_date;
    if v_schedule_count > 1 then
      raise exception 'Select the schedule to change for this date.';
    elsif v_schedule_count = 1 then
      select * into v_target
      from public.work_schedules schedule_row
      where schedule_row.user_id = v_user_id and schedule_row.shift_date = p_work_date
      for update;
      v_target_id := v_target.id;
    else
      v_timezone := coalesce(nullif(v_profile.timezone, ''), v_timezone);
    end if;
  end if;

  if v_target_id is not null then
    if v_target.status in ('cancelled', 'completed') then
      raise exception 'Cancelled or completed schedules cannot be requested for change.';
    end if;
    if v_target.is_leave or v_target.is_absent or v_target.is_rest_day or v_target.is_holiday then
      raise exception 'Leave, absence, rest-day, and holiday schedules cannot be changed through this request.';
    end if;
    v_timezone := coalesce(nullif(v_target.timezone, ''), v_timezone);
  end if;

  if v_timezone <> 'America/New_York' then
    raise exception 'The selected schedule timezone is not supported.';
  end if;

  if v_type = 'open_schedule' then
    if p_requested_shift_start is not null or p_requested_shift_end is not null then
      raise exception 'Open Schedule does not accept shift times.';
    end if;
    if p_requested_planned_paid_minutes is null
       or p_requested_planned_paid_minutes < 15
       or p_requested_planned_paid_minutes > 1440 then
      raise exception 'Open Schedule planned paid minutes must be between 15 and 1440.';
    end if;
  else
    if p_requested_shift_start is null or p_requested_shift_end is null then
      raise exception 'Slide Shift start and end times are required.';
    end if;
    if p_requested_shift_end <= p_requested_shift_start
       or p_requested_shift_end - p_requested_shift_start > interval '24 hours' then
      raise exception 'Slide Shift must be positive and no longer than 24 hours.';
    end if;
    if (p_requested_shift_start at time zone v_timezone)::date <> p_work_date then
      raise exception 'Slide Shift start must fall on the requested work date.';
    end if;
    if p_requested_planned_paid_minutes is not null then
      raise exception 'Slide Shift does not accept planned paid minutes.';
    end if;
  end if;

  if exists (
    select 1 from public.work_schedules schedule_row
    where schedule_row.user_id = v_user_id
      and schedule_row.shift_date = p_work_date
      and schedule_row.is_absent
  ) then
    raise exception 'An absence schedule prevents a schedule-change request on this date.';
  end if;
  if exists (
    select 1 from public.leave_requests request_row
    where request_row.user_id = v_user_id
      and request_row.request_category = 'schedule_change'
      and request_row.status = 'pending'
      and request_row.start_date = p_work_date
  ) then
    raise exception 'A pending schedule-change request already exists for this date.';
  end if;

  insert into public.leave_requests (
    user_id, leave_type, start_date, end_date, reason, status,
    request_category, request_type, target_schedule_id,
    target_schedule_version, target_schedule_updated_at,
    original_shift_start, original_shift_end, original_planned_paid_minutes,
    original_schedule_status, requested_shift_start, requested_shift_end,
    requested_planned_paid_minutes
  ) values (
    v_user_id, 'other', p_work_date, p_work_date, v_reason, 'pending',
    'schedule_change', v_type, v_target_id,
    case when v_target_id is null then null else v_target.schedule_version end,
    case when v_target_id is null then null else v_target.updated_at end,
    case when v_target_id is null then null else v_target.shift_start end,
    case when v_target_id is null then null else v_target.shift_end end,
    case when v_target_id is null then null else v_target.planned_paid_minutes end,
    case when v_target_id is null then null else v_target.status end,
    p_requested_shift_start, p_requested_shift_end,
    p_requested_planned_paid_minutes
  )
  returning * into v_result;
  return v_result;
end;
$function$;

revoke all on function public.workforce_submit_schedule_request(text, date, uuid, timestamptz, timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.workforce_submit_schedule_request(text, date, uuid, timestamptz, timestamptz, integer, text)
  to authenticated, service_role;

do $migration$
begin
  if to_regprocedure('public.workforce_review_schedule_request_without_stale_guard(uuid,text,text)') is null then
    alter function public.workforce_review_schedule_request(uuid, text, text)
      rename to workforce_review_schedule_request_without_stale_guard;
  end if;
end;
$migration$;

revoke all on function public.workforce_review_schedule_request_without_stale_guard(uuid, text, text)
  from public, anon, authenticated;

create or replace function public.workforce_review_schedule_request(
  p_request_id uuid,
  p_status text,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.leave_requests%rowtype;
  v_state jsonb;
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_current_rest smallint[];
  v_active_result public.leave_requests;
  v_result public.leave_requests;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_override_id uuid;
  v_previous_override text;
  v_previous_admin_self_apply text;
  v_override_active boolean := false;
  v_stale_message constant text :=
    'Schedule request is stale because the target schedule changed after submission. Review the current schedule and submit a new request.';
begin
  if v_status = 'approved' then
    select * into v_request from public.leave_requests where id = p_request_id for update;

    if v_request.id is not null and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change' then
      if v_request.request_type in ('open_schedule', 'slide_shift') then
        v_state := public.workforce_schedule_request_state_internal(p_request_id, true);
        if coalesce((v_state ->> 'verified')::boolean, false) is not true
           or coalesce((v_state ->> 'is_stale')::boolean, true) then
          raise exception '%', v_stale_message;
        end if;
        v_override_id := nullif(v_state ->> 'effective_target_schedule_id', '')::uuid;
      elsif v_request.request_type = 'rest_day_change' then
        select * into v_assignment
        from public.workforce_effective_weekly_assignment(v_request.user_id, v_request.start_date);
        if not found then raise exception '%', v_stale_message; end if;

        select * into v_assignment_row
        from public.work_schedule_template_assignments
        where id = v_assignment.assignment_id
        for update;
        select * into v_template
        from public.work_schedule_templates
        where id = v_assignment.template_id
        for update;
        select coalesce(array_agg(day_row.weekday order by day_row.weekday)
                        filter (where day_row.is_rest_day), '{}'::smallint[])
        into v_current_rest
        from public.work_schedule_template_days day_row
        where day_row.template_id = v_assignment.template_id;

        if not found
           or v_request.recurring_assignment_id is null
           or v_request.recurring_template_id is null
           or v_assignment_row.id is distinct from v_request.recurring_assignment_id
           or v_template.id is distinct from v_request.recurring_template_id
           or v_assignment_row.effective_from is distinct from v_request.recurring_assignment_effective_from
           or v_assignment_row.effective_until is distinct from v_request.recurring_assignment_effective_until
           or v_current_rest is distinct from v_request.current_rest_weekdays then
          raise exception '%', v_stale_message;
        end if;
      end if;
    end if;

    if v_request.id is not null and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change'
       and v_request.request_type in ('open_schedule', 'slide_shift') then
      v_previous_override := current_setting('workforce.schedule_request_target_override', true);
      perform set_config('workforce.schedule_request_target_override', coalesce(v_override_id::text, ''), true);
      v_override_active := true;
      v_previous_admin_self_apply := current_setting('workforce.schedule_request_admin_self_apply', true);
      if v_request.user_id = public.workforce_current_profile_id()
         and public.workforce_is_admin() then
        perform set_config('workforce.schedule_request_admin_self_apply', v_request.user_id::text, true);
      else
        perform set_config('workforce.schedule_request_admin_self_apply', '', true);
      end if;
      if to_regprocedure('public.workforce_review_schedule_request_active_session(uuid,text)') is not null then
        execute 'select public.workforce_review_schedule_request_active_session($1, $2)'
          into v_active_result using p_request_id, p_review_notes;
      else
        v_active_result := null;
      end if;
      if v_active_result.id is not null then
        perform set_config('workforce.schedule_request_target_override', coalesce(v_previous_override, ''), true);
        perform set_config('workforce.schedule_request_admin_self_apply', coalesce(v_previous_admin_self_apply, ''), true);
        return v_active_result;
      end if;
    end if;

    if v_request.id is not null and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change'
       and v_request.request_type = 'rest_day_change' then
      perform set_config('workforce.rest_day_change_sync', 'true', true);
    end if;
  end if;

  v_result := public.workforce_review_schedule_request_without_stale_guard(
    p_request_id, p_status, p_review_notes
  );
  if v_override_active then
    perform set_config('workforce.schedule_request_target_override', coalesce(v_previous_override, ''), true);
  end if;
  if v_override_active then
    perform set_config('workforce.schedule_request_admin_self_apply', coalesce(v_previous_admin_self_apply, ''), true);
  end if;
  return v_result;
end;
$function$;

revoke all on function public.workforce_review_schedule_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.workforce_review_schedule_request(uuid, text, text) to authenticated, service_role;

do $migration$
declare
  v_definition text;
  v_old text := $old$if v_profile.is_agent is not true then
    raise exception 'Schedules can only be assigned to profiles with agent access.';
  end if;$old$;
  v_new text := $new$if v_profile.is_agent is not true
     and not (
       current_setting('workforce.schedule_request_admin_self_apply', true) = p_user_id::text
       and public.workforce_is_admin()
       and public.workforce_current_profile_id() = p_user_id
     ) then
    raise exception 'Schedules can only be assigned to profiles with agent access.';
  end if;$new$;
  v_function regprocedure;
begin
  foreach v_function in array array[
    'public.workforce_admin_save_open_schedule_without_audit_reason(uuid,uuid,date,integer,text,text,text,integer)'::regprocedure,
    'public.workforce_admin_save_schedule(uuid,uuid,date,integer,timestamptz,timestamptz,text,text,boolean,boolean,text,text)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_function);
    if position(v_old in v_definition) = 0 then
      raise exception 'Could not find the expected agent-only schedule writer guard in %.', v_function;
    end if;
    execute replace(v_definition, v_old, v_new);
  end loop;
end;
$migration$;

create or replace function public.workforce_admin_save_open_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_timezone text,
  p_status text,
  p_notes text,
  p_planned_paid_minutes integer
)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing public.work_schedules%rowtype;
  v_result public.work_schedules%rowtype;
  v_started_at timestamptz := clock_timestamp();
  v_reason text := nullif(trim(coalesce(p_notes, '')), '');
  v_meaningful_change boolean := false;
  v_audit_id uuid;
  v_effective_schedule_id uuid := p_schedule_id;
  v_effective_sequence integer := p_shift_sequence;
  v_effective_timezone text := p_timezone;
  v_override_text text;
begin
  if p_schedule_id is null then
    v_override_text := nullif(current_setting('workforce.schedule_request_target_override', true), '');
    if v_override_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_existing
      from public.work_schedules
      where id = v_override_text::uuid
        and user_id = p_user_id
        and shift_date = p_shift_date
      for update;
      if found then
        v_effective_schedule_id := v_existing.id;
        v_effective_sequence := v_existing.shift_sequence;
        v_effective_timezone := v_existing.timezone;
      end if;
    end if;
  end if;

  if v_effective_schedule_id is not null then
    select * into v_existing from public.work_schedules where id = v_effective_schedule_id for update;
    if not found then raise exception 'Schedule entry not found.'; end if;
    v_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from v_effective_sequence::smallint
      or v_existing.shift_start is not null
      or v_existing.shift_end is not null
      or v_existing.timezone is distinct from coalesce(nullif(trim(v_effective_timezone), ''), 'America/New_York')
      or v_existing.is_rest_day
      or v_existing.is_holiday
      or v_existing.planned_paid_minutes is distinct from p_planned_paid_minutes;
    if v_meaningful_change and v_reason is null then
      raise exception 'A reason is required for open schedule corrections.';
    end if;
  end if;

  v_result := public.workforce_admin_save_open_schedule_without_audit_reason(
    v_effective_schedule_id, p_user_id, p_shift_date, v_effective_sequence, v_effective_timezone,
    p_status, p_notes, p_planned_paid_minutes
  );

  if v_meaningful_change then
    select log_row.id into v_audit_id
    from public.workforce_audit_logs log_row
    where log_row.entity_id = v_result.id
      and log_row.entity_type = 'work_schedules'
      and log_row.action = 'update'
      and log_row.created_at >= v_started_at
      and log_row.reason is null
    order by log_row.created_at desc
    limit 1;
    if v_audit_id is not null then
      update public.workforce_audit_logs set reason = v_reason where id = v_audit_id;
    else
      insert into public.workforce_audit_logs (
        actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
      ) values (
        v_actor, 'historical_schedule_correction', 'work_schedules', v_result.id,
        to_jsonb(v_existing), to_jsonb(v_result), v_reason
      );
    end if;
  end if;
  return v_result;
end;
$function$;

commit;



;
