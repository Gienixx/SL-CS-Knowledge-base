begin;
-- Rest Day prepaid balances are a distinct economic category.  The source
-- schedule remains an untimed Rest Day; the prepaid duration lives on the
-- immutable payroll snapshot rather than changing schedule classification.
alter table public.payroll_schedule_snapshots
  add column if not exists prepaid_minutes integer;
alter table public.payroll_schedule_snapshots
  drop constraint if exists payroll_schedule_snapshots_prepaid_minutes_check;
alter table public.payroll_schedule_snapshots
  add constraint payroll_schedule_snapshots_prepaid_minutes_check
  check (prepaid_minutes is null or prepaid_minutes > 0);
alter table public.payroll_prepaid_hours
  add column if not exists prepaid_day_type text not null default 'ordinary';
alter table public.payroll_prepaid_hours
  drop constraint if exists payroll_prepaid_hours_day_type_check;
alter table public.payroll_prepaid_hours
  add constraint payroll_prepaid_hours_day_type_check
  check (prepaid_day_type in ('ordinary', 'rest_day'));
alter table public.payroll_hour_allocations
  drop constraint if exists payroll_hour_allocations_category_check;
alter table public.payroll_hour_allocations
  add constraint payroll_hour_allocations_category_check
  check (
    minute_category in (
      'regular',
      'pre_shift_overtime',
      'post_shift_overtime',
      'rest_day_overtime'
    )
  );
-- Preserve the economic category when an audited correction creates a new
-- prepaid row. The column default is ordinary, so corrections must inherit
-- the source row explicitly.
create or replace function public.payroll_preserve_prepaid_day_type_on_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.correction_of_id is not null then
    select prepaid_day_type
    into new.prepaid_day_type
    from public.payroll_prepaid_hours
    where id = new.correction_of_id;
  end if;
  return new;
end;
$function$;
drop trigger if exists payroll_prepaid_hours_preserve_day_type_on_correction
  on public.payroll_prepaid_hours;
create trigger payroll_prepaid_hours_preserve_day_type_on_correction
before insert on public.payroll_prepaid_hours
for each row
execute function public.payroll_preserve_prepaid_day_type_on_correction();
-- The latest production trigger includes historical-restore and recalculation
-- provenance branches. Keep those branches intact while allowing an explicit
-- Rest Day source snapshot to create a balance from its stored prepaid minutes.
create or replace function public.payroll_create_prepaid_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_previous_balance record;
  v_new_prepaid_hour_id uuid;
  v_restore_minutes integer;
  v_prepaid_minutes integer := coalesce(new.prepaid_minutes, new.scheduled_minutes);
  v_day_type text := case when new.is_rest_day then 'rest_day' else 'ordinary' end;
begin
  if coalesce(new.source_metadata ->> 'recalculation_provenance_only', 'false') = 'true' then
    return new;
  end if;

  if coalesce(new.source_metadata ->> 'historical_restore', 'false') = 'true' then
    v_restore_minutes := (new.source_metadata ->> 'restored_prepaid_minutes')::integer;
    if v_restore_minutes is null or v_restore_minutes <= 0 then
      raise exception using errcode = '22023', message = 'Historical prepaid restoration requires positive restored minutes.';
    end if;
    insert into public.payroll_prepaid_hours (
      source_payroll_record_id, source_schedule_snapshot_id, employee_id,
      prepaid_minutes, settled_minutes, prepaid_day_type,
      created_by, created_at, updated_at
    )
    values (
      new.payroll_record_id, new.id, new.employee_id,
      v_restore_minutes, 0, v_day_type,
      new.approved_by, new.approved_at, new.approved_at
    )
    on conflict (source_schedule_snapshot_id, prepaid_version) do nothing
    returning id into v_new_prepaid_hour_id;
    return new;
  end if;

  if v_prepaid_minutes is null or v_prepaid_minutes <= 0 then
    raise exception using errcode = '22023', message = 'Prepaid minutes must be positive.';
  end if;

  if new.is_holiday then
    raise exception using errcode = '22023', message = 'Guaranteed special days do not create prepaid-hour debt.';
  end if;

  if not new.is_rest_day and new.scheduled_minutes <= 0 then
    raise exception using errcode = '22023', message = 'Only future ordinary schedules with positive minutes can create prepaid-hour balances.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_prepaid_hours:' || new.employee_id::text, 0)
  );

  for v_previous_balance in
    select prepaid.id, prepaid.settled_minutes
    from public.payroll_prepaid_hours prepaid
    join public.payroll_schedule_snapshots previous_snapshot
      on previous_snapshot.id = prepaid.source_schedule_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.schedule_id = new.schedule_id
      and previous_snapshot.id <> new.id
      and prepaid.voided_at is null
    order by previous_snapshot.schedule_version, prepaid.id
    for update of prepaid
  loop
    if v_previous_balance.settled_minutes > 0 then
      raise exception using errcode = '55000', message = 'A changed pre-plot cannot be reapproved after its prepaid balance has started settling.';
    end if;
  end loop;

  insert into public.payroll_prepaid_hours (
    source_payroll_record_id, source_schedule_snapshot_id, employee_id,
    prepaid_minutes, settled_minutes, prepaid_day_type,
    created_by, created_at, updated_at
  )
  values (
    new.payroll_record_id, new.id, new.employee_id,
    v_prepaid_minutes, 0, v_day_type,
    new.approved_by, new.approved_at, new.approved_at
  )
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
    and previous_snapshot.schedule_id = new.schedule_id
    and previous_snapshot.id <> new.id
    and prepaid.voided_at is null;

  return new;
end;
$function$;
-- Lock the current ordinary implementation behind a wrapper. The wrapper
-- handles only Rest Day source resolution; ordinary and holiday behavior stays
-- delegated to the exact production implementation.
alter function public.payroll_save_and_approve_prepaid_schedule(
  uuid, uuid, date, time without time zone, time without time zone, text, text, boolean
) rename to payroll_save_and_approve_prepaid_schedule_ordinary;
create function public.payroll_save_and_approve_prepaid_schedule(
  p_payroll_period_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_prepaid_login time without time zone,
  p_prepaid_logout time without time zone,
  p_timezone text,
  p_approval_reason text,
  p_allow_schedule_change boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_record public.payroll_records%rowtype;
  v_profile public.profiles%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_template_id uuid;
  v_template_timezone text;
  v_template_sequence smallint;
  v_reason text := nullif(trim(p_approval_reason), '');
  v_minutes integer;
  v_snapshot_id uuid;
  v_prepaid_id uuid;
begin
  if auth.uid() is null or v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501', message = 'You do not have permission to add payroll prepaid schedules.';
  end if;

  if p_payroll_period_id is null or p_employee_id is null or p_work_date is null
     or p_prepaid_login is null or p_prepaid_logout is null
     or nullif(trim(p_timezone), '') is null or v_reason is null then
    raise exception using errcode = '22023', message = 'Payroll period, employee, date, prepaid times, timezone, and approval reason are required.';
  end if;

  select * into v_period from public.payroll_periods where id = p_payroll_period_id for update;
  if not found or v_period.status not in ('draft', 'reopened') then
    raise exception using errcode = '55000', message = 'Prepaid schedules can only be added to draft or reopened payroll periods.';
  end if;
  if p_work_date <= v_period.payment_date or p_work_date > v_period.period_end then
    raise exception using errcode = '22023', message = 'The prepaid work date must be after payment and on or before the payroll cutoff.';
  end if;

  select * into v_record from public.payroll_records
  where payroll_period_id = v_period.id and employee_id = p_employee_id and status <> 'void' for update;
  if not found then raise exception using errcode = '22023', message = 'The selected employee is not loaded in this payroll period.'; end if;
  select * into v_profile from public.profiles where user_id = p_employee_id;
  if not found or not v_profile.is_agent or v_profile.employment_status not in ('active', 'on_leave') then
    raise exception using errcode = '22023', message = 'Prepaid schedules require an active or on-leave agent.';
  end if;
  if exists (select 1 from public.attendance where user_id = p_employee_id and work_date = p_work_date) then
    raise exception using errcode = '22023', message = 'Attendance already exists for this employee and date. Import approved attendance instead.';
  end if;

  select * into v_schedule from public.work_schedules
  where user_id = p_employee_id and shift_date = p_work_date
  order by shift_sequence, id limit 1 for update;

  -- Existing ordinary/holiday rows retain the exact production validation.
  if found and not v_schedule.is_rest_day then
    return public.payroll_save_and_approve_prepaid_schedule_ordinary(
      p_payroll_period_id, p_employee_id, p_work_date, p_prepaid_login,
      p_prepaid_logout, p_timezone, p_approval_reason, p_allow_schedule_change
    );
  end if;

  if not found then
    select assignment.template_id, template.timezone, template_day.shift_sequence
    into v_template_id, v_template_timezone, v_template_sequence
    from public.work_schedule_template_assignments assignment
    join public.work_schedule_templates template
      on template.id = assignment.template_id and template.is_active
    join public.work_schedule_template_days template_day
      on template_day.template_id = template.id
     and template_day.weekday = extract(dow from p_work_date)::integer
     and template_day.is_rest_day
    where assignment.is_active
      and (assignment.user_id = p_employee_id or (assignment.user_id is null and assignment.team_id = v_profile.team_id))
      and assignment.effective_from <= p_work_date
      and (assignment.effective_until is null or assignment.effective_until >= p_work_date)
    order by (assignment.user_id is not null) desc, assignment.created_at desc, template_day.shift_sequence
    limit 1;

    if v_template_id is null then
      return public.payroll_save_and_approve_prepaid_schedule_ordinary(
        p_payroll_period_id, p_employee_id, p_work_date, p_prepaid_login,
        p_prepaid_logout, p_timezone, p_approval_reason, p_allow_schedule_change
      );
    end if;

    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, is_rest_day, is_holiday, holiday_name, notes,
      schedule_template_id, generated_by_automation, admin_override,
      automation_leave_cancelled, created_by, updated_by
    ) values (
      p_employee_id, v_profile.team_id, p_work_date, v_template_sequence,
      null, null, coalesce(v_template_timezone, p_timezone), 'published', true,
      false, null, 'Created from Rest Day prepaid approval; schedule classification preserved.',
      v_template_id, true, false, false, v_actor, v_actor
    ) returning * into v_schedule;
  end if;

  if v_schedule.is_holiday then
    raise exception using errcode = '22023', message = 'Guaranteed special days do not create prepaid-hour debt.';
  end if;
  if v_schedule.status not in ('published', 'changed') then
    raise exception using errcode = '22023', message = 'Only published or changed Rest Day schedules may be prepaid.';
  end if;

  v_minutes := extract(epoch from ((p_work_date::timestamp + p_prepaid_logout + case when p_prepaid_logout <= p_prepaid_login then interval '1 day' else interval '0 days' end) - (p_work_date::timestamp + p_prepaid_login)))::integer / 60;
  if v_minutes <= 0 or v_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Prepaid times must create a positive duration of no more than 24 hours.';
  end if;

  select snapshot.id into v_snapshot_id
  from public.payroll_schedule_snapshots snapshot
  where snapshot.payroll_record_id = v_record.id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
    and snapshot.schedule_version = v_schedule.schedule_version
  order by snapshot.approved_at desc limit 1;
  if v_snapshot_id is null then
    insert into public.payroll_schedule_snapshots (
      payroll_record_id, schedule_id, employee_id, work_date,
      shift_start, shift_end, timezone, schedule_status, is_rest_day,
      is_holiday, holiday_name, schedule_version, schedule_updated_at,
      approved_by, approved_at, approval_reason, source_type, source_metadata,
      prepaid_minutes
    ) values (
      v_record.id, v_schedule.id, p_employee_id, p_work_date,
      null, null, v_schedule.timezone, v_schedule.status, true, false, null,
      v_schedule.schedule_version, v_schedule.updated_at, v_actor, statement_timestamp(),
      v_reason, 'website_schedule', jsonb_build_object(
        'entry_mode', 'payroll_prepaid_form',
        'prepaid_day_type', 'rest_day',
        'prepaid_login', p_prepaid_login,
        'prepaid_logout', p_prepaid_logout
      ), v_minutes
    ) returning id into v_snapshot_id;

    insert into public.payroll_audit_logs (
      actor_user_id, action, entity_type, entity_id, payroll_period_id,
      payroll_record_id, after_data, reason, metadata
    ) values (
      v_actor, 'payroll_rest_day_preplot_approved', 'payroll_schedule_snapshot',
      v_snapshot_id, v_period.id, v_record.id,
      jsonb_build_object(
        'schedule_id', v_schedule.id,
        'schedule_version', v_schedule.schedule_version,
        'prepaid_minutes', v_minutes,
        'prepaid_day_type', 'rest_day'
      ), v_reason,
      jsonb_build_object('schedule_created_by_prepaid_entry', v_template_id is not null)
    );
  end if;

  select id into v_prepaid_id from public.payroll_prepaid_hours where source_schedule_snapshot_id = v_snapshot_id;
  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'payroll_record_id', v_record.id,
    'employee_id', p_employee_id,
    'schedule_id', v_schedule.id,
    'schedule_version', v_schedule.schedule_version,
    'schedule_snapshot_id', v_snapshot_id,
    'prepaid_hour_id', v_prepaid_id,
    'schedule_action', case when v_template_id is null then 'existing' else 'created_rest_day' end,
    'prepaid_day_type', 'rest_day',
    'prepaid_minutes', v_minutes,
    'approved_schedule_count', case when v_prepaid_id is null then 0 else 1 end,
    'already_current_count', case when v_prepaid_id is null then 0 else 1 end
  );
end;
$function$;
revoke all on function public.payroll_save_and_approve_prepaid_schedule(
  uuid, uuid, date, time without time zone, time without time zone, text, text, boolean
) from public, anon;
grant execute on function public.payroll_save_and_approve_prepaid_schedule(
  uuid, uuid, date, time without time zone, time without time zone, text, text, boolean
) to authenticated, service_role;
-- Rest Day approvals settle only against Rest Day balances and use the explicit
-- rest_day_overtime minute category. Ordinary balances remain unchanged.
create or replace function public.payroll_reconcile_prepaid_hours()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_previous_allocation record;
  v_balance record;
  v_available integer;
  v_allocated integer;
  v_actor uuid := public.workforce_current_profile_id();
  v_category record;
begin
  if new.attendance_version > 2147483647 then
    raise exception
      using
        errcode = '22003',
        message = 'Attendance version is too large for payroll reconciliation.';
  end if;

  for v_previous_allocation in
    select allocation.*
    from public.payroll_hour_allocations allocation
    join public.payroll_attendance_snapshots previous_snapshot on previous_snapshot.id = allocation.attendance_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.attendance_id = new.attendance_id
      and previous_snapshot.id <> new.id
      and allocation.employee_id = new.employee_id
      and allocation.allocation_type = 'settlement'
      and not exists (select 1 from public.payroll_hour_allocations reversal where reversal.reverses_allocation_id = allocation.id)
    order by allocation.created_at, allocation.id
  loop
    select * into v_balance from public.payroll_prepaid_hours where id = v_previous_allocation.prepaid_hour_id for update;
    if not found or v_balance.settled_minutes < v_previous_allocation.allocated_minutes then
      raise exception using errcode = '23514', message = 'The prior prepaid-hour allocation cannot be safely reversed.';
    end if;
    insert into public.payroll_hour_allocations (
      prepaid_hour_id, employee_id, destination_payroll_record_id, attendance_snapshot_id,
      allocation_type, minute_category, allocated_minutes, calculation_version,
      reverses_allocation_id, reason, created_by
    ) values (
      v_previous_allocation.prepaid_hour_id, new.employee_id, new.payroll_record_id, new.id,
      'reversal', v_previous_allocation.minute_category, v_previous_allocation.allocated_minutes,
      new.attendance_version::integer, v_previous_allocation.id,
      'Reversed because a newer approved attendance version was imported.', v_actor
    );
    update public.payroll_prepaid_hours
    set settled_minutes = settled_minutes - v_previous_allocation.allocated_minutes,
        last_settled_at = case when settled_minutes - v_previous_allocation.allocated_minutes = 0 then null else last_settled_at end
    where id = v_previous_allocation.prepaid_hour_id;
  end loop;

  if new.special_day_type = 'rest_day' or new.is_rest_day then
    v_available := greatest(new.rest_day_overtime_minutes, 0);
    while v_available > 0 loop
      select prepaid.id, prepaid.remaining_minutes into v_balance
      from public.payroll_prepaid_hours prepaid
      join public.payroll_schedule_snapshots source_snapshot on source_snapshot.id = prepaid.source_schedule_snapshot_id
      where prepaid.employee_id = new.employee_id
        and prepaid.prepaid_day_type = 'rest_day'
        and prepaid.voided_at is null
        and prepaid.remaining_minutes > 0
        and source_snapshot.work_date <= new.work_date
      order by source_snapshot.work_date, prepaid.created_at, prepaid.id
      limit 1 for update of prepaid;
      exit when not found;
      v_allocated := least(v_available, v_balance.remaining_minutes);
      insert into public.payroll_hour_allocations (
        prepaid_hour_id, employee_id, destination_payroll_record_id, attendance_snapshot_id,
        allocation_type, minute_category, allocated_minutes, calculation_version,
        reason, created_by
      ) values (
        v_balance.id, new.employee_id, new.payroll_record_id, new.id, 'settlement',
        'rest_day_overtime', v_allocated, new.attendance_version::integer,
        'Applied approved Rest Day attendance to the Rest Day prepaid balance.', v_actor
      );
      update public.payroll_prepaid_hours
      set settled_minutes = settled_minutes + v_allocated, last_settled_at = statement_timestamp()
      where id = v_balance.id;
      v_available := v_available - v_allocated;
    end loop;
    if v_actor is not null then
      insert into public.payroll_audit_logs (
        actor_user_id, action, entity_type, entity_id, payroll_period_id,
        after_data, reason, metadata
      )
      select
        v_actor,
        'payroll_prepaid_hours_reconciled',
        'payroll_attendance_snapshot',
        new.id,
        record.payroll_period_id,
        jsonb_build_object('rest_day_overtime_minutes', new.rest_day_overtime_minutes),
        'Reconciled approved Rest Day attendance against Rest Day prepaid-hour balances.',
        jsonb_build_object(
          'attendance_id', new.attendance_id,
          'attendance_version', new.attendance_version,
          'employee_id', new.employee_id,
          'work_date', new.work_date,
          'prepaid_day_type', 'rest_day'
        )
      from public.payroll_records record
      where record.id = new.payroll_record_id;
    end if;
    return new;
  end if;

  if new.special_day_type <> 'ordinary' or new.is_holiday then return new; end if;

  for v_category in
    select category.minute_category, category.available_minutes
    from (values
      ('regular'::text, new.regular_minutes),
      ('pre_shift_overtime'::text, new.pre_shift_overtime_minutes),
      ('post_shift_overtime'::text, new.post_shift_overtime_minutes)
    ) category(minute_category, available_minutes)
  loop
    v_available := greatest(v_category.available_minutes, 0);
    while v_available > 0 loop
      select prepaid.id, prepaid.remaining_minutes into v_balance
      from public.payroll_prepaid_hours prepaid
      join public.payroll_schedule_snapshots source_snapshot on source_snapshot.id = prepaid.source_schedule_snapshot_id
      where prepaid.employee_id = new.employee_id and prepaid.prepaid_day_type = 'ordinary'
        and prepaid.voided_at is null and prepaid.remaining_minutes > 0
        and source_snapshot.work_date <= new.work_date
      order by source_snapshot.work_date, prepaid.created_at, prepaid.id limit 1 for update of prepaid;
      exit when not found;
      v_allocated := least(v_available, v_balance.remaining_minutes);
      insert into public.payroll_hour_allocations (
        prepaid_hour_id, employee_id, destination_payroll_record_id, attendance_snapshot_id,
        allocation_type, minute_category, allocated_minutes, calculation_version,
        reason, created_by
      ) values (
        v_balance.id, new.employee_id, new.payroll_record_id, new.id, 'settlement',
        v_category.minute_category, v_allocated, new.attendance_version::integer,
        'Applied approved ordinary attendance to the oldest ordinary prepaid-hour balance.', v_actor
      );
      update public.payroll_prepaid_hours set settled_minutes = settled_minutes + v_allocated, last_settled_at = statement_timestamp() where id = v_balance.id;
      v_available := v_available - v_allocated;
    end loop;
  end loop;

  if v_actor is not null then
    insert into public.payroll_audit_logs (
      actor_user_id, action, entity_type, entity_id, payroll_period_id,
      after_data, reason, metadata
    )
    select
      v_actor,
      'payroll_prepaid_hours_reconciled',
      'payroll_attendance_snapshot',
      new.id,
      record.payroll_period_id,
      jsonb_build_object('prepaid_day_type', 'ordinary'),
      'Reconciled approved ordinary attendance against ordinary prepaid-hour balances.',
      jsonb_build_object(
        'attendance_id', new.attendance_id,
        'attendance_version', new.attendance_version,
        'employee_id', new.employee_id,
        'work_date', new.work_date
      )
    from public.payroll_records record
    where record.id = new.payroll_record_id;
  end if;
  return new;
end;
$function$;
-- Run the existing calculator first, then remove only the base component of
-- Rest Day minutes already paid through a Rest Day prepaid balance. The
-- premium remains payable from actual approved Rest Day attendance. The
-- offset follows the settled minutes across the same entitlement bands as
-- the generated items: the first 480 minutes are represented by
-- rest_day_work, and later minutes by rest_day_excess.
-- The deployed calculator already contains the Rest Day line definitions;
-- they were disabled by WHERE false. Enable only those two existing branches.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_calculate_draft_for_record(uuid,uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$
    from payable
    where false

    union all

    select
      payable.payroll_record_id,
      'earning',
      'rest_day_excess',
$old$;
  v_new := $new$
    from payable
    where payable.special_day_type = 'rest_day'

    union all

    select
      payable.payroll_record_id,
      'earning',
      'rest_day_excess',
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected disabled Rest Day work branch was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
    from payable
    where false

    union all

    select
      payable.payroll_record_id,
      'earning',
      'holiday_work',
$old$;
  v_new := $new$
    from payable
    where payable.special_day_type = 'rest_day'

    union all

    select
      payable.payroll_record_id,
      'earning',
      'holiday_work',
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected disabled Rest Day excess branch was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
    from payable
    where payable.payable_total_minutes > 0
$old$;
  v_new := $new$
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.payable_total_minutes > 0
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected generic payable-hours branch was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
      payable.hourly_rate,
      round(
        greatest(
          coalesce(payable.rest_day_overtime_minutes, 0) - 480,
          0
          )::numeric / 60 * payable.hourly_rate,
$old$;
  v_new := $new$
      payable.effective_overtime_rate * 2,
      round(
        greatest(
          coalesce(payable.rest_day_overtime_minutes, 0) - 480,
          0
          )::numeric / 60 * payable.effective_overtime_rate * 2,
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected Rest Day excess-rate expression was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$patch$;
alter function public.payroll_calculate_draft_for_record(uuid, uuid)
  rename to payroll_calculate_draft_for_record_base;
create function public.payroll_calculate_draft_for_record(
  p_payroll_period_id uuid,
  p_payroll_record_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  v_result := public.payroll_calculate_draft_for_record_base(
    p_payroll_period_id,
    p_payroll_record_id
  );

  with covered as (
    select
      allocation.attendance_snapshot_id,
      least(
        sum(allocation.allocated_minutes)::integer,
        greatest(coalesce(attendance_snapshot.rest_day_overtime_minutes, 0), 0)
      )::integer as allocated_minutes,
      greatest(coalesce(attendance_snapshot.rest_day_overtime_minutes, 0), 0)::integer as worked_minutes,
      max(rate.hourly_rate) as hourly_rate
    from public.payroll_hour_allocations allocation
    join public.payroll_attendance_snapshots attendance_snapshot
      on attendance_snapshot.id = allocation.attendance_snapshot_id
    join public.payroll_prepaid_hours prepaid
      on prepaid.id = allocation.prepaid_hour_id
     and prepaid.prepaid_day_type = 'rest_day'
    join public.payroll_schedule_snapshots source_snapshot
      on source_snapshot.id = prepaid.source_schedule_snapshot_id
    join lateral (
      select effective_rate.*
      from public.agent_rates effective_rate
      where effective_rate.employee_id = prepaid.employee_id
        and effective_rate.effective_date <= source_snapshot.work_date
      order by effective_rate.effective_date desc
      limit 1
    ) rate on true
    where allocation.allocation_type = 'settlement'
      and allocation.minute_category = 'rest_day_overtime'
      and not exists (
        select 1
        from public.payroll_hour_allocations reversal
        where reversal.reverses_allocation_id = allocation.id
      )
      and (p_payroll_record_id is null or attendance_snapshot.payroll_record_id = p_payroll_record_id)
    group by allocation.attendance_snapshot_id, attendance_snapshot.rest_day_overtime_minutes
  )
  update public.payroll_items item
    set
      amount = round(
        greatest(
          item.amount - case
            when item.item_code = 'rest_day_work' then
              least(covered.allocated_minutes, 480)::numeric / 60 * covered.hourly_rate
            when item.item_code = 'rest_day_excess' then
              greatest(least(covered.allocated_minutes, covered.worked_minutes) - 480, 0)::numeric
                / 60 * covered.hourly_rate
            else 0
          end,
          0
        ),
        2
      ),
      metadata = item.metadata || jsonb_build_object(
        'rest_day_prepaid_minutes', covered.allocated_minutes,
        'rest_day_prepaid_base_offset', round(
          case
            when item.item_code = 'rest_day_work' then
              least(covered.allocated_minutes, 480)::numeric / 60 * covered.hourly_rate
            when item.item_code = 'rest_day_excess' then
              greatest(least(covered.allocated_minutes, covered.worked_minutes) - 480, 0)::numeric
                / 60 * covered.hourly_rate
            else 0
          end,
          2
        ),
        'rest_day_prepaid_accounting', 'base_paid_in_advance_premium_paid_on_actual_attendance'
      )
    from covered
    where item.source_attendance_snapshot_id = covered.attendance_snapshot_id
      and item.item_code in ('rest_day_work', 'rest_day_excess')
    ;

  with totals as (
    select
      record.id,
      coalesce(sum(item.amount) filter (where item.item_type = 'earning'), 0)::numeric(14,2) as gross_pay,
      coalesce(sum(item.amount) filter (where item.item_type = 'deduction'), 0)::numeric(14,2) as total_deductions,
      coalesce(sum(item.amount) filter (where item.item_code in ('rest_day_work', 'rest_day_excess')), 0)::numeric(14,2) as rest_day_pay
    from public.payroll_records record
    left join public.payroll_items item on item.payroll_record_id = record.id
    where record.payroll_period_id = p_payroll_period_id
      and (p_payroll_record_id is null or record.id = p_payroll_record_id)
      and record.status <> 'void'
    group by record.id
  )
  update public.payroll_records record
  set gross_pay = totals.gross_pay,
      total_deductions = totals.total_deductions,
      net_pay = totals.gross_pay - totals.total_deductions,
      rest_day_pay = totals.rest_day_pay
  from totals
  where record.id = totals.id;

  select v_result || jsonb_build_object(
    'gross_pay', coalesce(sum(record.gross_pay), 0)::numeric(14,2),
    'net_pay', coalesce(sum(record.net_pay), 0)::numeric(14,2),
    'total_deductions', coalesce(sum(record.total_deductions), 0)::numeric(14,2)
  )
  into v_result
  from public.payroll_records record
  where record.payroll_period_id = p_payroll_period_id
    and (p_payroll_record_id is null or record.id = p_payroll_record_id)
    and record.status <> 'void';

  return v_result;
end;
$function$;
revoke all on function public.payroll_calculate_draft_for_record(uuid, uuid)
  from public, anon;
grant execute on function public.payroll_calculate_draft_for_record(uuid, uuid)
  to authenticated, service_role;
-- The existing candidate RPC only returns dated work_schedules. This read path
-- exposes eligible recurring Rest Days that have not been materialized yet so
-- Payroll Period can label them before approval; it does not create a row.
create function public.payroll_get_rest_day_prepaid_candidates(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  schedule_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  work_date date,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text,
  scheduled_minutes integer,
  schedule_status text,
  is_rest_day boolean,
  is_holiday boolean,
  holiday_name text,
  special_day_type text,
  schedule_version bigint,
  schedule_updated_at timestamptz,
  can_approve boolean,
  approval_status text,
  approval_message text,
  current_snapshot_id uuid,
  approved_at timestamptz,
  approval_reason text,
  approved_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception using errcode = '42501', message = 'You do not have permission to view payroll pre-plots.';
  end if;

  return query
  select distinct on (profile.user_id, period_date.work_date::date)
    record.id,
    null::uuid,
    profile.user_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    period_date.work_date::date,
    null::timestamptz,
    null::timestamptz,
    coalesce(template.timezone, 'America/New_York'),
    0,
    'published'::text,
    true,
    false,
    null::text,
    'rest_day'::text,
    0::bigint,
    null::timestamptz,
    true,
    'rest_day'::text,
    'Rest Day — prepaid hours preserve the Rest Day classification and settle against later approved Rest Day work.'::text,
    null::uuid,
    null::timestamptz,
    null::text,
    null::text
  from public.payroll_records record
  join public.profiles profile on profile.user_id = record.employee_id
  join public.payroll_periods period on period.id = record.payroll_period_id
  join lateral generate_series(
    greatest(period.payment_date + 1, period.period_start)::date,
    period.period_end,
    interval '1 day'
  ) as period_date(work_date) on true
  join public.work_schedule_template_assignments assignment
    on assignment.is_active
   and (assignment.user_id = profile.user_id or (assignment.user_id is null and assignment.team_id = profile.team_id))
   and assignment.effective_from <= period_date.work_date::date
   and (assignment.effective_until is null or assignment.effective_until >= period_date.work_date::date)
  join public.work_schedule_templates template
    on template.id = assignment.template_id and template.is_active
  join public.work_schedule_template_days template_day
    on template_day.template_id = template.id
   and template_day.weekday = extract(dow from period_date.work_date::date)::integer
   and template_day.is_rest_day
  where record.payroll_period_id = p_payroll_period_id
    and record.status <> 'void'
    and not exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = profile.user_id
        and schedule.shift_date = period_date.work_date::date
    )
    and not exists (
      select 1 from public.attendance attendance_row
      where attendance_row.user_id = profile.user_id
        and attendance_row.work_date = period_date.work_date::date
  )
  order by
    profile.user_id,
    period_date.work_date::date,
    (assignment.user_id is not null) desc,
    assignment.created_at desc,
    template_day.shift_sequence;
end;
$function$;
revoke all on function public.payroll_get_rest_day_prepaid_candidates(uuid)
  from public, anon;
grant execute on function public.payroll_get_rest_day_prepaid_candidates(uuid)
  to authenticated, service_role;
-- The existing exception read model predates Rest Day prepaid balances. Patch
-- only its classification and audit predicates; ordinary and holiday guards
-- remain unchanged.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_get_period_exceptions(uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$
      prepaid.prepaid_minutes,
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
$old$;
  v_new := $new$
      prepaid.prepaid_minutes,
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
      prepaid.prepaid_day_type,
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid exception balance projection was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
        prepaid.prepaid_minutes <= 0
        or prepaid.scheduled_minutes is null
        or prepaid.scheduled_minutes <= 0
        or prepaid.prepaid_minutes <> prepaid.scheduled_minutes
        or prepaid.schedule_status not in ('published', 'changed', 'completed')
        or prepaid.is_rest_day
        or prepaid.is_holiday
        or prepaid.effective_shift_start is null
        or prepaid.effective_shift_end is null
        or prepaid.effective_shift_end <= prepaid.effective_shift_start
        or nullif(trim(prepaid.effective_timezone), '') is null
        or prepaid.work_date not between v_period.period_start and v_period.period_end
$old$;
  v_new := $new$
        prepaid.prepaid_minutes <= 0
        or prepaid.schedule_status not in ('published', 'changed', 'completed')
        or prepaid.is_holiday
        or prepaid.work_date not between v_period.period_start and v_period.period_end
        or (prepaid.is_rest_day and prepaid.prepaid_day_type <> 'rest_day')
        or (not prepaid.is_rest_day and (
          prepaid.scheduled_minutes is null
          or prepaid.scheduled_minutes <= 0
          or prepaid.prepaid_minutes <> prepaid.scheduled_minutes
          or prepaid.effective_shift_start is null
          or prepaid.effective_shift_end is null
          or prepaid.effective_shift_end <= prepaid.effective_shift_start
          or nullif(trim(prepaid.effective_timezone), '') is null
        ))
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected invalid prepaid predicate was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$audit.action = 'payroll_preplots_approved'$old$;
  v_new := $new$audit.action in ('payroll_preplots_approved', 'payroll_rest_day_preplot_approved')$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected website prepaid audit predicate was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$patch$;
-- Expose the immutable accounting category to the existing correction UI.
do $patch$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_get_period_prepaid_hours(uuid)'::regprocedure
  ) into v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    'settled_minutes integer,' ,
    'settled_minutes integer, prepaid_day_type text,'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '    prepaid.settled_minutes,' || chr(10) || '    prepaid.remaining_minutes,',
    '    prepaid.settled_minutes,' || chr(10) || '    prepaid.prepaid_day_type,' || chr(10) || '    prepaid.remaining_minutes,'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '    prepaid.settled_minutes,' || chr(10) || '    prepaid.status,',
    '    prepaid.settled_minutes,' || chr(10) || '    prepaid.prepaid_day_type,' || chr(10) || '    prepaid.status,'
  );
  if position('prepaid_day_type text' in v_definition) = 0
     or position('prepaid.prepaid_day_type' in v_definition) = 0 then
    raise exception 'Expected prepaid period read model fields were not found.';
  end if;
  drop function public.payroll_get_period_prepaid_hours(uuid);
  execute v_definition;
  revoke all on function public.payroll_get_period_prepaid_hours(uuid) from public, anon;
  grant execute on function public.payroll_get_period_prepaid_hours(uuid) to authenticated, service_role;
end;
$patch$;
-- Extend the existing audited correction RPC. Its existing locks and all
-- draft, settled-balance, attendance, duplicate-date, supersession, and audit
-- guards remain in force; only the unconditional Rest Day rejection changes.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_correct_prepaid_hours(uuid, date, time without time zone, time without time zone, text, text)'::regprocedure
  ) into v_definition;

  v_old := '  v_schedule_count integer := 0;' || chr(10) || '  v_new_id uuid;';
  v_new := '  v_schedule_count integer := 0;' || chr(10) ||
    '  v_recurring_rest_day_count integer := 0;' || chr(10) ||
    '  v_target_is_rest_day boolean := false;' || chr(10) ||
    '  v_new_id uuid;';
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid correction declaration was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '    if v_target_schedule.is_rest_day then' || chr(10) ||
    '      raise exception' || chr(10) ||
    '        using errcode = ''22023'', message = ''Rest days do not create prepaid-hour debt.'';' || chr(10) ||
    '    end if;' || chr(10) || chr(10) ||
    '    if v_target_schedule.is_holiday then';
  v_new := '    if v_target_schedule.is_holiday then';
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected Rest Day correction guard was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '    if v_target_schedule.status in (''cancelled'', ''completed'') then' || chr(10) ||
    '      raise exception' || chr(10) ||
    '        using' || chr(10) ||
    '          errcode = ''22023'',' || chr(10) ||
    '          message = ''Cancelled or completed schedules cannot receive corrected prepaid hours.'';' || chr(10) ||
    '    end if;' || chr(10) ||
    '  end if;' || chr(10) || chr(10) ||
    '  if exists (';
  v_new := '    if v_target_schedule.status in (''cancelled'', ''completed'') then' || chr(10) ||
    '      raise exception' || chr(10) ||
    '        using' || chr(10) ||
    '          errcode = ''22023'',' || chr(10) ||
    '          message = ''Cancelled or completed schedules cannot receive corrected prepaid hours.'';' || chr(10) ||
    '    end if;' || chr(10) ||
    '    v_target_is_rest_day := v_target_schedule.is_rest_day;' || chr(10) ||
    '  else' || chr(10) ||
    '    select count(*)::integer' || chr(10) ||
    '    into v_recurring_rest_day_count' || chr(10) ||
    '    from public.work_schedule_template_assignments as assignment' || chr(10) ||
    '    join public.work_schedule_templates as template' || chr(10) ||
    '      on template.id = assignment.template_id' || chr(10) ||
    '     and template.is_active' || chr(10) ||
    '    join public.work_schedule_template_days as template_day' || chr(10) ||
    '      on template_day.template_id = template.id' || chr(10) ||
    '     and template_day.weekday = extract(isodow from p_work_date)::smallint' || chr(10) ||
    '     and template_day.is_rest_day' || chr(10) ||
    '    where assignment.user_id = v_old.employee_id' || chr(10) ||
    '      and assignment.is_active' || chr(10) ||
    '      and assignment.effective_from <= p_work_date' || chr(10) ||
    '      and (assignment.effective_until is null or assignment.effective_until >= p_work_date);' || chr(10) ||
    '    if v_recurring_rest_day_count > 1 then' || chr(10) ||
    '      raise exception using errcode = ''22023'', message = ''Multiple recurring Rest Day assignments exist for this employee and corrected work date.'';' || chr(10) ||
    '    end if;' || chr(10) ||
    '    v_target_is_rest_day := v_recurring_rest_day_count = 1;' || chr(10) ||
    '  end if;' || chr(10) || chr(10) ||
    '  if v_old.prepaid_day_type = ''rest_day'' and not v_target_is_rest_day then' || chr(10) ||
    '    raise exception using errcode = ''22023'', message = ''Prepaid corrections cannot change the prepaid day type. Create the appropriate prepaid entry through the normal payroll workflow.'';' || chr(10) ||
    '  end if;' || chr(10) ||
    '  if v_old.prepaid_day_type = ''ordinary'' and v_target_is_rest_day then' || chr(10) ||
    '    raise exception using errcode = ''22023'', message = ''Prepaid corrections cannot change the prepaid day type. Create the appropriate prepaid entry through the normal payroll workflow.'';' || chr(10) ||
    '  end if;' || chr(10) || chr(10) ||
    '  if exists (';
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid correction schedule block was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '    employee_id,' || chr(10) || '    prepaid_minutes,' || chr(10) || '    settled_minutes,';
  v_new := '    employee_id,' || chr(10) || '    prepaid_minutes,' || chr(10) || '    prepaid_day_type,' || chr(10) || '    settled_minutes,';
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := '    v_old.employee_id,' || chr(10) || '    v_minutes,' || chr(10) || '    0,';
  v_new := '    v_old.employee_id,' || chr(10) || '    v_minutes,' || chr(10) || '    v_old.prepaid_day_type,' || chr(10) || '    0,';
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '      ''prepaid_hour_id'', v_old.id,' || chr(10) || '      ''prepaid_version'', v_old.prepaid_version,';
  v_new := '      ''prepaid_hour_id'', v_old.id,' || chr(10) || '      ''prepaid_day_type'', v_old.prepaid_day_type,' || chr(10) || '      ''prepaid_version'', v_old.prepaid_version,';
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := '      ''prepaid_hour_id'', v_new_id,' || chr(10) || '      ''prepaid_version'', v_old.prepaid_version + 1,';
  v_new := '      ''prepaid_hour_id'', v_new_id,' || chr(10) || '      ''prepaid_day_type'', v_old.prepaid_day_type,' || chr(10) || '      ''prepaid_version'', v_old.prepaid_version + 1,';
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := '    ''prepaid_minutes'', v_minutes,' || chr(10) || '    ''work_date'', p_work_date,';
  v_new := '    ''prepaid_minutes'', v_minutes,' || chr(10) || '    ''prepaid_day_type'', v_old.prepaid_day_type,' || chr(10) || '    ''work_date'', p_work_date,';
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

execute v_definition;
end;
$patch$;
-- The hardened correction RPC normally requires a dated source schedule. For
-- Rest Day corrections, an effective recurring Rest Day assignment is also an
-- authoritative source; ordinary corrections retain the dated-source guard.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_correct_prepaid_hours(uuid, date, time without time zone, time without time zone, text, text)'::regprocedure
  ) into v_definition;
  v_old := '  if v_schedule_count = 0 then' || chr(10) ||
    '    -- Initial creation may create an Open Schedule with schedule-management' || chr(10) ||
    '    -- permission. Correction never changes a live schedule, so its target' || chr(10) ||
    '    -- date must already have a source schedule.' || chr(10) ||
    '    raise exception' || chr(10) ||
    '      using' || chr(10) ||
    '        errcode = ''22023'',' || chr(10) ||
    '        message = ''A source schedule is required for the corrected prepaid work date.'';' || chr(10) ||
    '  end if;';
  v_new := '  if v_schedule_count = 0 then' || chr(10) ||
    '    select count(*)::integer' || chr(10) ||
    '    into v_recurring_rest_day_count' || chr(10) ||
    '    from public.work_schedule_template_assignments as assignment' || chr(10) ||
    '    join public.work_schedule_templates as template' || chr(10) ||
    '      on template.id = assignment.template_id and template.is_active' || chr(10) ||
    '    join public.work_schedule_template_days as template_day' || chr(10) ||
    '      on template_day.template_id = template.id' || chr(10) ||
    '     and template_day.weekday = extract(isodow from p_work_date)::smallint' || chr(10) ||
    '     and template_day.is_rest_day' || chr(10) ||
    '    where assignment.user_id = v_old.employee_id' || chr(10) ||
    '      and assignment.is_active' || chr(10) ||
    '      and assignment.effective_from <= p_work_date' || chr(10) ||
    '      and (assignment.effective_until is null or assignment.effective_until >= p_work_date);' || chr(10) ||
    '    if v_old.prepaid_day_type <> ''rest_day'' or v_recurring_rest_day_count = 0 then' || chr(10) ||
    '      raise exception using errcode = ''22023'', message = ''A source schedule is required for the corrected prepaid work date.'';' || chr(10) ||
    '    end if;' || chr(10) ||
    '  end if;';
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected hardened correction source-schedule guard was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;
commit;
