-- Read-only, caller-scoped lifecycle information for pending Schedule Requests.
-- Approval RPCs and their existing triggers remain the final authority.
create or replace function public.workforce_get_schedule_request_lifecycle(
  p_request_ids uuid[]
)
returns table (
  request_id uuid,
  is_stale boolean,
  reason_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request_id uuid;
  v_request public.leave_requests%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_state jsonb;
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_current_rest smallint[];
  v_allowed boolean;
  v_schedule_count integer;
  v_schedule_minutes integer;
  v_midpoint timestamptz;
  v_expected_start timestamptz;
  v_expected_end timestamptz;
  v_stale boolean;
  v_reason_code text;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Active workforce access is required.';
  end if;

  for v_request_id in
    select distinct requested.id
    from unnest(coalesce(p_request_ids, '{}'::uuid[])) as requested(id)
    where requested.id is not null
    order by requested.id
  loop
    select request_row.*
    into v_request
    from public.leave_requests request_row
    where request_row.id = v_request_id
      and request_row.status = 'pending';

    if not found then
      continue;
    end if;

    -- Match the caller to the current workforce identity, or require the
    -- existing scoped permissions used by the corresponding review RPC.
    v_allowed := public.workforce_is_current_identity(v_request.user_id);
    if not coalesce(v_allowed, false) and public.workforce_is_admin() then
      if coalesce(v_request.request_category, 'leave') = 'leave' then
        v_allowed := public.workforce_can_manage_user(
          v_request.user_id, 'approve_leave'
        );
      elsif v_request.request_category = 'schedule_change' then
        v_allowed := public.workforce_can_manage_user(
            v_request.user_id, 'approve_leave'
          )
          and public.workforce_can_manage_user(
            v_request.user_id, 'manage_schedules'
          );
      end if;
    end if;

    -- Return no row for unauthorized or unknown IDs so callers cannot use the
    -- RPC to enumerate requests or learn which authorization check failed.
    if not coalesce(v_allowed, false) then
      continue;
    end if;

    v_stale := false;
    v_reason_code := 'unchanged';

    if coalesce(v_request.request_category, 'leave') = 'leave' then
      -- Whole Day intentionally retains its existing date-based lifecycle.
      if v_request.leave_duration = 'whole_day' then
        v_reason_code := 'whole_day';
      elsif v_request.leave_duration is null
         or v_request.leave_duration not in ('half_day', 'specific_time') then
        v_stale := true;
        v_reason_code := 'unverifiable';
      else
        select count(*)::integer
        into v_schedule_count
        from public.work_schedules schedule_row
        where schedule_row.user_id = v_request.user_id
          and schedule_row.shift_date = v_request.start_date
          and schedule_row.status in ('published', 'changed');

        if v_schedule_count <> 1 then
          v_stale := true;
          v_reason_code := 'unverifiable';
        else
          select schedule_row.*
          into v_schedule
          from public.work_schedules schedule_row
          where schedule_row.id = v_request.requested_schedule_id
            and schedule_row.user_id = v_request.user_id
            and schedule_row.shift_date = v_request.start_date;

          if not found then
            v_stale := true;
            v_reason_code := 'unverifiable';
          elsif v_schedule.status not in ('published', 'changed')
             or v_schedule.is_rest_day
             or v_schedule.is_holiday
             or v_schedule.is_leave
             or v_schedule.is_absent
             or v_schedule.shift_start is null
             or v_schedule.shift_end is null
             or v_schedule.shift_start is distinct from v_request.requested_schedule_start
             or v_schedule.shift_end is distinct from v_request.requested_schedule_end
             or coalesce(nullif(trim(v_schedule.timezone), ''), 'America/New_York')
               is distinct from v_request.requested_schedule_timezone then
            v_stale := true;
            v_reason_code := 'schedule_changed';
          elsif v_schedule.shift_end <= v_schedule.shift_start
             or v_schedule.shift_end - v_schedule.shift_start > interval '24 hours'
             or v_request.requested_leave_start is null
             or v_request.requested_leave_end is null
             or v_request.requested_leave_start >= v_request.requested_leave_end
             or v_request.requested_leave_start < v_schedule.shift_start
             or v_request.requested_leave_end > v_schedule.shift_end then
            v_stale := true;
            v_reason_code := 'schedule_changed';
          elsif v_request.leave_duration = 'half_day' then
            if v_request.leave_half is null
               or v_request.leave_half not in ('first', 'second') then
              v_stale := true;
              v_reason_code := 'unverifiable';
            else
              v_schedule_minutes := floor(
                extract(epoch from (v_schedule.shift_end - v_schedule.shift_start)) / 60
              )::integer;
              v_midpoint := v_schedule.shift_start
                + make_interval(mins => v_schedule_minutes / 2);

              if v_request.leave_half = 'first' then
                v_expected_start := v_schedule.shift_start;
                v_expected_end := v_midpoint;
              else
                v_expected_start := v_midpoint;
                v_expected_end := v_schedule.shift_end;
              end if;

              if v_request.requested_leave_start is distinct from v_expected_start
                 or v_request.requested_leave_end is distinct from v_expected_end then
                v_stale := true;
                v_reason_code := 'schedule_changed';
              end if;
            end if;
          end if;
        end if;
      end if;

    elsif v_request.request_category = 'schedule_change'
       and v_request.request_type in ('open_schedule', 'slide_shift') then
      -- Reuse the exact Production baseline/material-state validator without
      -- acquiring locks or taking its approval-time override path.
      v_state := public.workforce_schedule_request_state_internal(
        v_request.id, false
      );
      if coalesce((v_state ->> 'verified')::boolean, false) is not true then
        v_stale := true;
        v_reason_code := 'unverifiable';
      elsif coalesce((v_state ->> 'is_stale')::boolean, true) then
        v_stale := true;
        v_reason_code := 'schedule_changed';
      end if;

    elsif v_request.request_category = 'schedule_change'
       and v_request.request_type = 'rest_day_change' then
      -- Match the Rest Day Change approval guard's current assignment and
      -- template snapshot checks. Missing current state fails closed.
      select *
      into v_assignment
      from public.workforce_effective_weekly_assignment(
        v_request.user_id, v_request.start_date
      );

      if not found then
        v_stale := true;
        v_reason_code := 'unverifiable';
      else
        select *
        into v_assignment_row
        from public.work_schedule_template_assignments
        where id = v_assignment.assignment_id;

        if not found then
          v_stale := true;
          v_reason_code := 'unverifiable';
        else
          select *
          into v_template
          from public.work_schedule_templates
          where id = v_assignment.template_id;

          if not found then
            v_stale := true;
            v_reason_code := 'unverifiable';
          else
            select coalesce(
              array_agg(day_row.weekday order by day_row.weekday)
                filter (where day_row.is_rest_day),
              '{}'::smallint[]
            )
            into v_current_rest
            from public.work_schedule_template_days day_row
            where day_row.template_id = v_assignment.template_id;

            if v_request.recurring_assignment_id is null
               or v_request.recurring_template_id is null
               or v_request.current_rest_weekdays is null then
              v_stale := true;
              v_reason_code := 'unverifiable';
            elsif v_assignment_row.id is distinct from v_request.recurring_assignment_id
               or v_template.id is distinct from v_request.recurring_template_id
               or v_assignment_row.effective_from is distinct from v_request.recurring_assignment_effective_from
               or v_assignment_row.effective_until is distinct from v_request.recurring_assignment_effective_until
               or v_current_rest is distinct from v_request.current_rest_weekdays then
              v_stale := true;
              v_reason_code := 'schedule_changed';
            end if;
          end if;
        end if;
      end if;

    else
      -- Unknown categories/types cannot be certified as current.
      v_stale := true;
      v_reason_code := 'unverifiable';
    end if;

    return query select v_request.id, v_stale, v_reason_code;
  end loop;
end;
$$;

revoke all on function public.workforce_get_schedule_request_lifecycle(uuid[])
  from public, anon;
grant execute on function public.workforce_get_schedule_request_lifecycle(uuid[])
  to authenticated;

comment on function public.workforce_get_schedule_request_lifecycle(uuid[]) is
  'Returns computed stale lifecycle state for authorized pending Schedule Requests without changing request or schedule data.';

;
