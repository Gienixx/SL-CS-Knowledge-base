begin;

-- Keep generated Leave requests anchored to the schedule that created them.
alter table public.leave_requests
  add column if not exists generated_from_schedule_id uuid;

create unique index if not exists leave_requests_generated_schedule_unique_idx
  on public.leave_requests (generated_from_schedule_id)
  where generated_from_schedule_id is not null;

comment on column public.leave_requests.generated_from_schedule_id is
  'Paid VL Leave row generated from this published schedule; the schedule remains the source of truth.';

create or replace function public.workforce_clear_generated_paid_vl_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.leave_request_id is not null
     and exists (
       select 1
       from public.leave_requests request
       where request.id = old.leave_request_id
         and request.generated_from_schedule_id = old.id
     )
     and not (
       new.status in ('published', 'changed', 'completed')
       and new.is_leave
       and not new.is_absent
       and public.workforce_is_paid_leave_type(new.leave_type)
     ) then
    new.leave_request_id := null;
  end if;

  return new;
end;
$$;

revoke all on function public.workforce_clear_generated_paid_vl_link()
  from public, anon, authenticated;

drop trigger if exists work_schedules_clear_generated_paid_vl_link
  on public.work_schedules;
create trigger work_schedules_clear_generated_paid_vl_link
  before update of user_id, shift_date, status, is_leave, is_absent, leave_type
  on public.work_schedules
  for each row execute function public.workforce_clear_generated_paid_vl_link();
create or replace function public.workforce_sync_paid_vl_schedule_leave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_actor uuid;
  v_paid_vl boolean;
begin
  if tg_op = 'DELETE' then
    select request.id into v_request_id
    from public.leave_requests request
    where request.generated_from_schedule_id = old.id;

    if v_request_id is not null then
      delete from public.leave_requests where id = v_request_id;
    end if;
    return old;
  end if;

  v_paid_vl := new.status in ('published', 'changed', 'completed')
    and new.is_leave
    and not new.is_absent
    and public.workforce_is_paid_leave_type(new.leave_type);

  if not v_paid_vl then
    if tg_op = 'UPDATE' then
      select request.id into v_request_id
      from public.leave_requests request
      where request.generated_from_schedule_id = old.id;

      if v_request_id is not null then
        delete from public.leave_requests where id = v_request_id;
      end if;
    end if;
    return new;
  end if;

  -- Preserve a separately approved employee Leave request if this schedule
  -- already belongs to it. Generated entries are owned by this schedule.
  if new.leave_request_id is not null and exists (
    select 1
    from public.leave_requests request
    where request.id = new.leave_request_id
      and request.generated_from_schedule_id is null
      and request.user_id = new.user_id
      and request.status = 'approved'
      and coalesce(request.request_category, 'leave') = 'leave'
      and public.workforce_leave_request_schedule_type(request.leave_type) = new.leave_type
      and new.shift_date between request.start_date and request.end_date
  ) then
    select request.id into v_request_id
    from public.leave_requests request
    where request.generated_from_schedule_id = new.id;

    if v_request_id is not null and v_request_id is distinct from new.leave_request_id then
      delete from public.leave_requests where id = v_request_id;
    end if;
    return new;
  end if;

  v_actor := coalesce(new.updated_by, new.created_by, auth.uid());
  if v_actor is null then
    raise exception 'A paid VL schedule needs a recorded publisher to create its Leave record.';
  end if;

  -- Insert as pending first so the existing approved-leave schedule trigger
  -- cannot create a second schedule before this Leave row is linked.
  insert into public.leave_requests (
    user_id, leave_type, start_date, end_date, reason, status,
    reviewed_by, reviewed_at, request_category, request_type,
    generated_from_schedule_id
  ) values (
    new.user_id, new.leave_type, new.shift_date, new.shift_date,
    'Published paid VL schedule.', 'pending', null, null, 'leave',
    new.leave_type, new.id
  )
  on conflict do nothing
  returning id into v_request_id;

  if v_request_id is null then
    select request.id into v_request_id
    from public.leave_requests request
    where request.generated_from_schedule_id = new.id;
  end if;

  if v_request_id is null then
    raise exception 'Could not create the Leave record for the paid VL schedule.';
  end if;

  if new.leave_request_id is distinct from v_request_id then
    update public.work_schedules schedule
    set leave_request_id = v_request_id
    where schedule.id = new.id
      and schedule.leave_request_id is distinct from v_request_id;
  end if;

  -- This remains the existing payroll source: an approved Leave request linked
  -- to a published paid-VL schedule. The existing request trigger sees the
  -- schedule link and therefore does not add another schedule.
  update public.leave_requests request
  set user_id = new.user_id,
      leave_type = new.leave_type,
      start_date = new.shift_date,
      end_date = new.shift_date,
      reason = 'Published paid VL schedule.',
      status = 'approved',
      reviewed_by = v_actor,
      reviewed_at = coalesce(request.reviewed_at, now()),
      request_category = 'leave',
      request_type = new.leave_type,
      updated_at = now()
  where request.id = v_request_id
    and (
      request.user_id is distinct from new.user_id
      or request.leave_type is distinct from new.leave_type
      or request.start_date is distinct from new.shift_date
      or request.end_date is distinct from new.shift_date
      or request.status is distinct from 'approved'
      or request.reviewed_by is distinct from v_actor
      or request.request_category is distinct from 'leave'
      or request.request_type is distinct from new.leave_type
    );

  return new;
end;
$$;

revoke all on function public.workforce_sync_paid_vl_schedule_leave()
  from public, anon, authenticated;

drop trigger if exists work_schedules_sync_paid_vl_leave
  on public.work_schedules;
create trigger work_schedules_sync_paid_vl_leave
  after insert or update of user_id, shift_date, status, is_leave, is_absent, leave_type
  on public.work_schedules
  for each row execute function public.workforce_sync_paid_vl_schedule_leave();

drop trigger if exists work_schedules_delete_paid_vl_leave
  on public.work_schedules;
create trigger work_schedules_delete_paid_vl_leave
  after delete on public.work_schedules
  for each row execute function public.workforce_sync_paid_vl_schedule_leave();

-- Extend the employee-scoped Attendance Log with a Leave-only row. Clocks and
-- worked/billed minutes remain null or zero; no attendance session is created.
do $$
declare
  v_definition text;
  v_old text := '  select * from actual_rows' || chr(10)
    || '  union all' || chr(10)
    || '  select * from prepaid_rows';
  v_new text := '  select * from actual_rows' || chr(10)
    || '  union all' || chr(10)
    || '  select * from prepaid_rows' || chr(10)
    || '  union all' || chr(10)
    || '  select' || chr(10)
    || '    null::uuid as attendance_id,' || chr(10)
    || '    schedule.id as schedule_id,' || chr(10)
    || '    schedule.shift_date as work_date,' || chr(10)
    || '    null::timestamptz as clock_in,' || chr(10)
    || '    null::timestamptz as clock_out,' || chr(10)
    || '    null::timestamptz as original_clock_in,' || chr(10)
    || '    null::timestamptz as original_clock_out,' || chr(10)
    || '    null::timestamptz as billed_clock_in,' || chr(10)
    || '    null::timestamptz as billed_clock_out,' || chr(10)
    || '    ''leave''::text as attendance_status,' || chr(10)
    || '    ''approved''::text as review_status,' || chr(10)
    || '    false as is_late,' || chr(10)
    || '    0::integer as minutes_late,' || chr(10)
    || '    0::integer as overtime_minutes,' || chr(10)
    || '    0::integer as regular_minutes,' || chr(10)
    || '    0::integer as pre_shift_overtime_minutes,' || chr(10)
    || '    0::integer as post_shift_overtime_minutes,' || chr(10)
    || '    0::integer as rest_day_overtime_minutes,' || chr(10)
    || '    0::integer as holiday_overtime_minutes,' || chr(10)
    || '    0::integer as total_overtime_minutes,' || chr(10)
    || '    0::integer as total_worked_minutes,' || chr(10)
    || '    0::integer as undertime_minutes,' || chr(10)
    || '    null::text as correction_reason,' || chr(10)
    || '    null::timestamptz as corrected_at,' || chr(10)
    || '    schedule.created_at,' || chr(10)
    || '    schedule.updated_at,' || chr(10)
    || '    schedule.shift_start as schedule_start,' || chr(10)
    || '    schedule.shift_end as schedule_end,' || chr(10)
    || '    schedule.timezone as schedule_timezone,' || chr(10)
    || '    schedule.status as schedule_status,' || chr(10)
    || '    coalesce(schedule.is_rest_day, false) as schedule_is_rest_day,' || chr(10)
    || '    coalesce(schedule.is_holiday, false) as schedule_is_holiday,' || chr(10)
    || '    schedule.holiday_name,' || chr(10)
    || '    false as is_prepaid_schedule,' || chr(10)
    || '    null::integer as prepaid_minutes,' || chr(10)
    || '    0::integer as fulfilled_prepaid_minutes,' || chr(10)
    || '    0::integer as regular_payable_minutes,' || chr(10)
    || '    null::text as prepaid_status' || chr(10)
    || '  from public.work_schedules schedule' || chr(10)
    || '  join public.leave_requests request on request.id = schedule.leave_request_id' || chr(10)
    || '  where schedule.user_id = v_employee_id' || chr(10)
    || '    and request.user_id = v_employee_id' || chr(10)
    || '    and request.status = ''approved''' || chr(10)
    || '    and coalesce(request.request_category, ''leave'') = ''leave''' || chr(10)
    || '    and schedule.is_leave' || chr(10)
    || '    and not schedule.is_absent' || chr(10)
    || '    and schedule.status in (''published'', ''changed'', ''completed'')' || chr(10)
    || '    and public.workforce_is_paid_leave_type(coalesce(nullif(schedule.leave_type, ''''), request.leave_type))' || chr(10)
    || '    and schedule.shift_date between p_start_date and p_end_date';
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_list_my_attendance_log(date,date)'::regprocedure
  ), chr(13), '');

  if strpos(v_definition, v_old) = 0 then
    raise exception 'Attendance Log live definition did not contain its final attendance/prepaid union.';
  end if;

  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$$;

commit;

;
