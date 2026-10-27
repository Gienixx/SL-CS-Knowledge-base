begin;
-- Approved Rest Day Change synchronization is an audited application of the
-- recurring template, not a manual Workforce Management edit.  Keep the
-- existing admin_override behavior for all other updates, but recognize the
-- transaction-local marker set only by the guarded approval wrapper below.
create or replace function public.workforce_mark_generated_schedule_override()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.generated_by_automation
     and pg_trigger_depth() = 1
     and auth.uid() is not null
     and coalesce(current_setting('workforce.rest_day_change_sync', true), 'false') <> 'true'
     and (
       new.shift_date is distinct from old.shift_date
       or new.shift_sequence is distinct from old.shift_sequence
       or new.shift_start is distinct from old.shift_start
       or new.shift_end is distinct from old.shift_end
       or new.timezone is distinct from old.timezone
       or new.status is distinct from old.status
       or new.is_rest_day is distinct from old.is_rest_day
       or new.is_holiday is distinct from old.is_holiday
       or new.holiday_name is distinct from old.holiday_name
     ) then
    new.admin_override := true;
  end if;

  return new;
end;
$$;
-- Recreate the deployed stale-protection wrapper so the marker is enabled only
-- after all request/recurring-source provenance checks pass and immediately
-- before delegation to the existing audited approval workflow.
create or replace function public.workforce_review_schedule_request(
  p_request_id uuid,
  p_status text,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.leave_requests%rowtype;
  v_target public.work_schedules%rowtype;
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_current_rest smallint[];
  v_status text := lower(trim(coalesce(p_status, '')));
  v_stale_message constant text :=
    'Schedule request is stale because the target schedule changed after submission. Review the current schedule and submit a new request.';
begin
  if v_status = 'approved' then
    select * into v_request
    from public.leave_requests
    where id = p_request_id
    for update;

    if v_request.id is not null and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change' then
      if v_request.request_type in ('open_schedule', 'slide_shift') then
        if v_request.target_schedule_id is null then
          if exists (
            select 1 from public.work_schedules schedule_row
            where schedule_row.user_id = v_request.user_id
              and schedule_row.shift_date = v_request.start_date
          ) then
            raise exception '%', v_stale_message;
          end if;
        else
          select * into v_target
          from public.work_schedules
          where id = v_request.target_schedule_id
          for update;

          if not found
             or v_request.target_schedule_version is null
             or v_request.target_schedule_updated_at is null
             or v_target.schedule_version is distinct from v_request.target_schedule_version
             or v_target.updated_at is distinct from v_request.target_schedule_updated_at
             or v_target.shift_start is distinct from v_request.original_shift_start
             or v_target.shift_end is distinct from v_request.original_shift_end
             or v_target.planned_paid_minutes is distinct from v_request.original_planned_paid_minutes
             or v_target.status is distinct from v_request.original_schedule_status then
            raise exception '%', v_stale_message;
          end if;
        end if;
      elsif v_request.request_type = 'rest_day_change' then
        select * into v_assignment
        from public.workforce_effective_weekly_assignment(
          v_request.user_id, v_request.start_date
        );

        if not found then
          raise exception '%', v_stale_message;
        end if;

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
           or v_template.updated_at is distinct from v_request.recurring_template_updated_at
           or v_current_rest is distinct from v_request.current_rest_weekdays then
          raise exception '%', v_stale_message;
        end if;
      end if;
    end if;

    if found and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change'
       and v_request.request_type in ('open_schedule', 'slide_shift') then
      declare
        v_active_result public.leave_requests;
      begin
        v_active_result := public.workforce_review_schedule_request_active_session(
          p_request_id, p_review_notes
        );
        if v_active_result.id is not null then
          return v_active_result;
        end if;
      end;
    end if;

    if v_request.id is not null
       and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change'
       and v_request.request_type = 'rest_day_change' then
      perform set_config('workforce.rest_day_change_sync', 'true', true);
    end if;
  end if;

  return public.workforce_review_schedule_request_without_stale_guard(
    p_request_id, p_status, p_review_notes
  );
end;
$$;
revoke all on function public.workforce_review_schedule_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_review_schedule_request(uuid, text, text)
  to authenticated, service_role;
comment on function public.workforce_review_schedule_request(uuid, text, text) is
  'Rejects stale schedule-change requests and marks approved Rest Day Change synchronization as transaction-local generated-row work.';
commit;
