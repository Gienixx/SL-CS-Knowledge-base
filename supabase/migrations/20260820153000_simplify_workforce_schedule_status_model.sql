begin;

-- Operational status is now Published.  Keep the legacy status values in the
-- check constraint for historical rows, but make all new/editable schedules
-- operationally published.  Changed and Completed are display metadata.
alter table public.work_schedules
  add column if not exists changed_at timestamptz,
  add column if not exists changed_by uuid references public.profiles(user_id) on delete set null;

create or replace function public.workforce_apply_simplified_schedule_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_meaningful_change boolean := false;
begin
  if new.status = 'cancelled'
     and not coalesce(new.automation_leave_cancelled, false) then
    if tg_op = 'INSERT' then
      raise exception 'Cancelled is not a selectable schedule status. Delete an unused schedule instead.';
    elsif old.status is distinct from new.status then
      raise exception 'Cancelled is not a selectable schedule status. Delete an unused schedule instead.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    v_meaningful_change :=
      old.user_id is distinct from new.user_id
      or old.shift_date is distinct from new.shift_date
      or old.shift_sequence is distinct from new.shift_sequence
      or old.shift_start is distinct from new.shift_start
      or old.shift_end is distinct from new.shift_end
      or old.timezone is distinct from new.timezone
      or old.is_rest_day is distinct from new.is_rest_day
      or old.is_holiday is distinct from new.is_holiday
      or old.holiday_name is distinct from new.holiday_name
      or old.is_leave is distinct from new.is_leave
      or old.is_absent is distinct from new.is_absent
      or old.leave_type is distinct from new.leave_type
      or old.absence_type is distinct from new.absence_type
      or old.notes is distinct from new.notes
      or old.planned_paid_minutes is distinct from new.planned_paid_minutes;

    if v_meaningful_change then
      new.changed_at := coalesce(old.changed_at, now());
      new.changed_by := coalesce(old.changed_by, new.updated_by, auth.uid());
    end if;
  end if;

  -- Leave integration still owns the legacy cancelled state for historical
  -- leave transitions.  The manager save paths cannot create a new draft,
  -- changed, or completed operational state after this trigger is installed.
  if new.status <> 'cancelled' then
    new.status := 'published';
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedules_apply_simplified_status on public.work_schedules;
create trigger work_schedules_apply_simplified_status
before insert or update on public.work_schedules
for each row execute function public.workforce_apply_simplified_schedule_status();

-- Preserve historical provenance before converting legacy operational values.
update public.work_schedules schedule
set changed_at = coalesce(
      schedule.changed_at,
      (
        select audit.created_at
        from public.workforce_audit_logs audit
        where audit.entity_id = schedule.id
          and audit.entity_type in ('work_schedule', 'work_schedules')
          and audit.action in ('update', 'historical_schedule_correction')
        order by audit.created_at
        limit 1
      ),
      schedule.updated_at
    ),
    changed_by = coalesce(
      schedule.changed_by,
      (
        select audit.actor_user_id
        from public.workforce_audit_logs audit
        where audit.entity_id = schedule.id
          and audit.entity_type in ('work_schedule', 'work_schedules')
          and audit.action in ('update', 'historical_schedule_correction')
        order by audit.created_at
        limit 1
      ),
      schedule.updated_by
    )
where schedule.status = 'changed'
   or schedule.admin_override
   or exists (
        select 1
        from public.workforce_audit_logs audit
        where audit.entity_id = schedule.id
          and audit.entity_type in ('work_schedule', 'work_schedules')
          and audit.action in ('update', 'historical_schedule_correction')
      );

-- A scheduled row is a legacy draft and is deliberately not auto-published by
-- this migration: it must be reviewed before normalization.  The current
-- production audit has zero such rows.  Changed/completed rows are safe to
-- normalize because their provenance and attendance remain separate.
do $$
begin
  if exists (select 1 from public.work_schedules where status = 'scheduled') then
    raise exception 'Legacy scheduled rows require explicit review before status normalization.';
  end if;
end;
$$;

update public.work_schedules
set status = 'published'
where status in ('changed', 'completed');

create or replace function public.workforce_admin_delete_schedule(
  p_schedule_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule public.work_schedules%rowtype;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_schedules') then
    raise exception 'Administrator schedule-management access is required.'
      using errcode = '42501';
  end if;

  if p_schedule_id is null then
    raise exception 'Schedule ID is required.';
  end if;

  select * into v_schedule
  from public.work_schedules
  where id = p_schedule_id
  for update;

  if not found then
    raise exception 'Schedule entry not found.';
  end if;

  if not public.workforce_can_manage_user(v_schedule.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to delete this employee schedule.'
      using errcode = '42501';
  end if;

  if exists (select 1 from public.attendance where schedule_id = p_schedule_id) then
    raise exception 'This schedule cannot be deleted because attendance history is linked to it.';
  end if;

  if exists (
    select 1 from public.attendance_corrections
    where schedule_id = p_schedule_id
       or previous_schedule_id = p_schedule_id
       or new_schedule_id = p_schedule_id
  ) then
    raise exception 'This schedule cannot be deleted because correction history references it.';
  end if;

  if exists (
    select 1 from public.leave_requests
    where target_schedule_id = p_schedule_id
  ) or v_schedule.leave_request_id is not null
     or v_schedule.is_leave
     or v_schedule.is_absent then
    raise exception 'This schedule cannot be deleted because leave or absence history references it.';
  end if;

  if exists (select 1 from public.payroll_attendance_snapshots where schedule_id = p_schedule_id)
     or exists (select 1 from public.payroll_items where source_schedule_id = p_schedule_id)
     or exists (select 1 from public.payroll_schedule_snapshots where schedule_id = p_schedule_id) then
    raise exception 'This schedule cannot be deleted because payroll history references it.';
  end if;

  if exists (
    select 1 from public.workforce_audit_logs
    where entity_id = p_schedule_id
      and entity_type in ('work_schedule', 'work_schedules')
      and action not in ('insert', 'delete')
  ) then
    raise exception 'This schedule cannot be deleted because audit history references it.';
  end if;

  delete from public.work_schedules where id = p_schedule_id;

  return jsonb_build_object(
    'deleted_schedule_id', v_schedule.id,
    'employee_user_id', v_schedule.user_id,
    'shift_date', v_schedule.shift_date
  );
end;
$$;

revoke all on function public.workforce_admin_delete_schedule(uuid) from public;
revoke all on function public.workforce_admin_delete_schedule(uuid) from anon;
grant execute on function public.workforce_admin_delete_schedule(uuid) to authenticated;

comment on function public.workforce_admin_delete_schedule(uuid) is
  'Deletes only an unreferenced schedule; attendance, payroll, leave, correction, and audit history are never detached or cascaded.';

commit;
