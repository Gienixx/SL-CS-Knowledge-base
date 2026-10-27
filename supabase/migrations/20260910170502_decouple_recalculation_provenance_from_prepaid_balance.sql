-- Recalculation provenance snapshots are not new prepaid approvals.
-- They carry current schedule provenance for payroll items while the
-- historical prepaid source remains the authoritative economic entitlement.

create or replace function public.payroll_ensure_current_schedule_snapshot(
  p_payroll_record_id uuid,
  p_schedule_id uuid,
  p_employee_id uuid,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schedule public.work_schedules%rowtype;
  v_snapshot_id uuid;
  v_approved_by uuid;
begin
  select schedule.*
  into v_schedule
  from public.work_schedules as schedule
  where schedule.id = p_schedule_id
    and schedule.user_id = p_employee_id
  for share;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Current payroll source schedule was not found.';
  end if;

  if v_schedule.status not in ('published', 'changed', 'completed') then
    raise exception using errcode = '55000',
      message = 'Current payroll source schedule is not payable.';
  end if;

  select snapshot.id
  into v_snapshot_id
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
    and snapshot.schedule_version = v_schedule.schedule_version
  order by snapshot.approved_at desc
  limit 1;

  if v_snapshot_id is not null then
    return v_snapshot_id;
  end if;

  select snapshot.approved_by
  into v_approved_by
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
  order by snapshot.schedule_version desc, snapshot.approved_at desc
  limit 1;

  v_approved_by := coalesce(v_approved_by, p_actor_user_id);

  if v_approved_by is null then
    raise exception using errcode = '42501',
      message = 'Current payroll schedule provenance needs an approving actor.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id, schedule_id, employee_id, work_date,
    shift_start, shift_end, timezone, schedule_status, is_rest_day,
    is_holiday, holiday_name, schedule_version, schedule_updated_at,
    approved_by, approved_at, approval_reason, source_type, source_reference,
    source_metadata
  )
  values (
    p_payroll_record_id, v_schedule.id, p_employee_id, v_schedule.shift_date,
    v_schedule.shift_start, v_schedule.shift_end, v_schedule.timezone,
    v_schedule.status, v_schedule.is_rest_day, v_schedule.is_holiday,
    v_schedule.holiday_name, v_schedule.schedule_version, v_schedule.updated_at,
    v_approved_by, pg_catalog.now(),
    'Current authoritative schedule captured during payroll recalculation',
    'website_schedule', null,
    jsonb_build_object(
      'source', 'current_work_schedule',
      'recalculation_provenance_only', true,
      'previous_snapshot_preserved', true
    )
  )
  on conflict (payroll_record_id, schedule_id, schedule_version) do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    select snapshot.id
    into v_snapshot_id
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.payroll_record_id = p_payroll_record_id
      and snapshot.employee_id = p_employee_id
      and snapshot.schedule_id = v_schedule.id
      and snapshot.schedule_version = v_schedule.schedule_version
    order by snapshot.approved_at desc
    limit 1;
  end if;

  return v_snapshot_id;
end;
$function$;

revoke all on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.payroll_create_prepaid_balance()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_previous_balance record;
  v_new_prepaid_hour_id uuid;
  v_restore_minutes integer;
begin
  if coalesce(new.source_metadata ->> 'recalculation_provenance_only', 'false') = 'true' then
    return new;
  end if;

  if coalesce(new.source_metadata ->> 'historical_restore', 'false') = 'true' then
    v_restore_minutes := (new.source_metadata ->> 'restored_prepaid_minutes')::integer;
    if v_restore_minutes is null or v_restore_minutes <= 0 then
      raise exception using errcode = '22023', message = 'Historical prepaid restoration requires positive restored minutes.';
    end if;
    insert into public.payroll_prepaid_hours (source_payroll_record_id, source_schedule_snapshot_id, employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at)
    values (new.payroll_record_id, new.id, new.employee_id, v_restore_minutes, 0, new.approved_by, new.approved_at, new.approved_at)
    on conflict (source_schedule_snapshot_id, prepaid_version) do nothing
    returning id into v_new_prepaid_hour_id;
    return new;
  end if;

  if new.is_rest_day or new.is_holiday or new.scheduled_minutes <= 0 then
    raise exception using errcode = '22023', message = 'Only future ordinary schedules with positive minutes can create prepaid-hour balances.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.payroll_prepaid_hours:' || new.employee_id::text, 0));
  for v_previous_balance in
    select prepaid.id, prepaid.settled_minutes
    from public.payroll_prepaid_hours prepaid
    join public.payroll_schedule_snapshots previous_snapshot on previous_snapshot.id = prepaid.source_schedule_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.schedule_id = new.schedule_id and previous_snapshot.id <> new.id
      and prepaid.voided_at is null
    order by previous_snapshot.schedule_version, prepaid.id for update of prepaid
  loop
    if v_previous_balance.settled_minutes > 0 then
      raise exception using errcode = '55000', message = 'A changed pre-plot cannot be reapproved after its prepaid balance has started settling.';
    end if;
  end loop;

  insert into public.payroll_prepaid_hours (source_payroll_record_id, source_schedule_snapshot_id, employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at)
  values (new.payroll_record_id, new.id, new.employee_id, new.scheduled_minutes, 0, new.approved_by, new.approved_at, new.approved_at)
  on conflict (source_schedule_snapshot_id, prepaid_version) do nothing
  returning id into v_new_prepaid_hour_id;

  if v_new_prepaid_hour_id is null then
    select prepaid.id into v_new_prepaid_hour_id
    from public.payroll_prepaid_hours prepaid
    where prepaid.source_schedule_snapshot_id = new.id;
  end if;

  update public.payroll_prepaid_hours prepaid
  set voided_at = new.approved_at,
      voided_by = new.approved_by,
      void_reason = 'Superseded by approved schedule version ' || new.schedule_version::text || '.',
      superseded_by_id = v_new_prepaid_hour_id
  from public.payroll_schedule_snapshots previous_snapshot
  where previous_snapshot.id = prepaid.source_schedule_snapshot_id
    and previous_snapshot.payroll_record_id = new.payroll_record_id
    and previous_snapshot.schedule_id = new.schedule_id and previous_snapshot.id <> new.id
    and prepaid.voided_at is null;

  return new;
end;
$function$;

;
