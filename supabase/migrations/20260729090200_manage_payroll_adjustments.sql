-- Phase 2 Step 9: audited manual earnings and deductions.
-- Employee-visible descriptions remain on payroll_items. Private correction
-- notes are written only to payroll_audit_logs, which agents cannot read.

begin;

alter table public.payroll_items
  add constraint payroll_items_private_notes_not_exposed_check
  check (correction_notes is null),
  add constraint payroll_items_manual_shape_check
  check (
    not is_manual
    or (
      item_code in ('manual_earning', 'manual_deduction')
      and amount > 0
      and rate_id is null
      and source_attendance_snapshot_id is null
      and source_schedule_snapshot_id is null
      and source_schedule_id is null
      and source_schedule_version is null
    )
  );

comment on column public.payroll_items.description is
  'Employee-visible payroll line description.';
comment on column public.payroll_items.correction_notes is
  'Reserved and constrained to NULL. Private correction notes are stored only in payroll_audit_logs metadata.';

create or replace function public.payroll_rebuild_record_totals(
  p_payroll_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.payroll_records%rowtype;
  v_period_status text;
  v_basic_pay numeric(14,2);
  v_prepaid_pay numeric(14,2);
  v_overtime_pay numeric(14,2);
  v_rest_day_pay numeric(14,2);
  v_holiday_pay numeric(14,2);
  v_other_earnings numeric(14,2);
  v_gross_pay numeric(14,2);
  v_late_deduction numeric(14,2);
  v_undertime_deduction numeric(14,2);
  v_unpaid_absence_deduction numeric(14,2);
  v_other_deductions numeric(14,2);
  v_total_deductions numeric(14,2);
begin
  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = p_payroll_record_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll record was not found.';
  end if;

  select period.status
  into v_period_status
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id
  for update;

  if v_period_status not in ('draft', 'reopened')
     or v_record.status in ('approved', 'finalized', 'void') then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized or non-editable payroll cannot be changed.';
  end if;

  select
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code = 'regular_earnings'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code = 'prepaid_scheduled_earnings'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code in (
          'pre_shift_overtime',
          'post_shift_overtime'
        )
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code in ('rest_day_work', 'rest_day_excess')
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code in (
          'holiday_guarantee',
          'holiday_work',
          'holiday_excess'
        )
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
        and item.item_code not in (
          'regular_earnings',
          'prepaid_scheduled_earnings',
          'pre_shift_overtime',
          'post_shift_overtime',
          'rest_day_work',
          'rest_day_excess',
          'holiday_guarantee',
          'holiday_work',
          'holiday_excess'
        )
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'earning'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
        and item.item_code = 'late_deduction'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
        and item.item_code = 'undertime_deduction'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
        and item.item_code = 'unpaid_absence'
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
        and item.item_code not in (
          'late_deduction',
          'undertime_deduction',
          'unpaid_absence',
          'government_deduction',
          'statutory_deduction'
        )
    ), 0),
    coalesce(sum(item.amount) filter (
      where item.item_type = 'deduction'
    ), 0)
  into
    v_basic_pay,
    v_prepaid_pay,
    v_overtime_pay,
    v_rest_day_pay,
    v_holiday_pay,
    v_other_earnings,
    v_gross_pay,
    v_late_deduction,
    v_undertime_deduction,
    v_unpaid_absence_deduction,
    v_other_deductions,
    v_total_deductions
  from public.payroll_items as item
  where item.payroll_record_id = v_record.id;

  if v_total_deductions > v_gross_pay then
    raise exception
      using
        errcode = '22023',
        message = 'This deduction would make the employee net pay negative.';
  end if;

  update public.payroll_records
  set
    status = 'ready_for_review',
    basic_pay = v_basic_pay,
    prepaid_pay = v_prepaid_pay,
    overtime_pay = v_overtime_pay,
    rest_day_pay = v_rest_day_pay,
    holiday_pay = v_holiday_pay,
    other_earnings = v_other_earnings,
    gross_pay = v_gross_pay,
    late_deduction = v_late_deduction,
    undertime_deduction = v_undertime_deduction,
    unpaid_absence_deduction = v_unpaid_absence_deduction,
    government_deductions = 0,
    other_deductions = v_other_deductions,
    total_deductions = v_total_deductions,
    net_pay = v_gross_pay - v_total_deductions,
    updated_at = statement_timestamp()
  where id = v_record.id;
end;
$$;

revoke all on function public.payroll_rebuild_record_totals(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_rebuild_record_totals(uuid)
  to service_role;

comment on function public.payroll_rebuild_record_totals(uuid) is
  'Internal Step 9 total rebuild. Not exposed to browser roles.';

create or replace function public.payroll_save_adjustment(
  p_payroll_record_id uuid,
  p_payroll_item_id uuid,
  p_item_type text,
  p_description text,
  p_amount numeric,
  p_adjustment_reason text,
  p_correction_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_record public.payroll_records%rowtype;
  v_period_status text;
  v_item public.payroll_items%rowtype;
  v_before_data jsonb;
  v_after_data jsonb;
  v_action text;
  v_description text := trim(coalesce(p_description, ''));
  v_reason text := trim(coalesce(p_adjustment_reason, ''));
  v_private_notes text := nullif(trim(coalesce(p_correction_notes, '')), '');
  v_amount numeric(14,2);
  v_item_code text;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to manage payroll adjustments.';
  end if;

  if p_payroll_record_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll record is required.';
  end if;

  if p_item_type not in ('earning', 'deduction') then
    raise exception
      using
        errcode = '22023',
        message = 'Adjustment type must be earning or deduction.';
  end if;

  if length(v_description) < 3 or length(v_description) > 200 then
    raise exception
      using
        errcode = '22023',
        message = 'Employee-visible description must be 3 to 200 characters.';
  end if;

  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception
      using
        errcode = '22023',
        message = 'Adjustment reason must be 3 to 500 characters.';
  end if;

  if v_private_notes is not null and length(v_private_notes) > 2000 then
    raise exception
      using
        errcode = '22023',
        message = 'Private correction notes cannot exceed 2,000 characters.';
  end if;

  if p_amount is null
     or p_amount <= 0
     or p_amount > 99999999.99 then
    raise exception
      using
        errcode = '22023',
        message = 'Adjustment amount must be greater than zero and within the supported USD limit.';
  end if;

  v_amount := round(p_amount, 2);
  v_item_code := case
    when p_item_type = 'earning' then 'manual_earning'
    else 'manual_deduction'
  end;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = p_payroll_record_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll record was not found.';
  end if;

  select period.status
  into v_period_status
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id
  for update;

  if v_period_status not in ('draft', 'reopened')
     or v_record.status in ('approved', 'finalized', 'void') then
    raise exception
      using
        errcode = '55000',
        message = 'Adjustments are allowed only while payroll is editable.';
  end if;

  if v_record.calculated_at is null then
    raise exception
      using
        errcode = '55000',
        message = 'Calculate draft payroll before adding adjustments.';
  end if;

  if p_payroll_item_id is null then
    v_action := 'payroll_adjustment_added';
    insert into public.payroll_items (
      payroll_record_id,
      item_type,
      item_code,
      description,
      quantity,
      unit_rate,
      amount,
      is_manual,
      adjustment_reason,
      correction_notes,
      created_by,
      calculation_version,
      metadata,
      created_at
    )
    values (
      v_record.id,
      p_item_type,
      v_item_code,
      v_description,
      1,
      v_amount,
      v_amount,
      true,
      v_reason,
      null,
      v_actor_user_id,
      v_record.calculation_version,
      jsonb_build_object(
        'adjustment_version', 1,
        'employee_visible_description', true,
        'private_notes_stored_in_audit', true,
        'last_changed_by', v_actor_user_id,
        'last_changed_at', statement_timestamp()
      ),
      statement_timestamp()
    )
    returning * into v_item;
    v_before_data := null;
  else
    select item.*
    into v_item
    from public.payroll_items as item
    where item.id = p_payroll_item_id
      and item.payroll_record_id = v_record.id
    for update;

    if not found or not v_item.is_manual then
      raise exception
        using
          errcode = 'P0002',
          message = 'Manual payroll adjustment was not found.';
    end if;

    v_action := 'payroll_adjustment_updated';
    v_before_data := jsonb_build_object(
      'item_type', v_item.item_type,
      'item_code', v_item.item_code,
      'description', v_item.description,
      'amount', v_item.amount,
      'adjustment_reason', v_item.adjustment_reason,
      'adjustment_version',
        coalesce((v_item.metadata ->> 'adjustment_version')::integer, 1)
    );

    update public.payroll_items
    set
      item_type = p_item_type,
      item_code = v_item_code,
      description = v_description,
      quantity = 1,
      unit_rate = v_amount,
      amount = v_amount,
      adjustment_reason = v_reason,
      correction_notes = null,
      metadata = v_item.metadata || jsonb_build_object(
        'adjustment_version',
          coalesce(
            (v_item.metadata ->> 'adjustment_version')::integer,
            1
          ) + 1,
        'employee_visible_description', true,
        'private_notes_stored_in_audit', true,
        'last_changed_by', v_actor_user_id,
        'last_changed_at', statement_timestamp()
      )
    where id = v_item.id
    returning * into v_item;
  end if;

  perform public.payroll_rebuild_record_totals(v_record.id);

  v_after_data := jsonb_build_object(
    'item_type', v_item.item_type,
    'item_code', v_item.item_code,
    'description', v_item.description,
    'amount', v_item.amount,
    'adjustment_reason', v_item.adjustment_reason,
    'adjustment_version',
      coalesce((v_item.metadata ->> 'adjustment_version')::integer, 1)
  );

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    payroll_record_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    v_action,
    'payroll_adjustment',
    v_item.id,
    v_record.payroll_period_id,
    v_record.id,
    v_before_data,
    v_after_data,
    v_reason,
    jsonb_build_object(
      'private_correction_notes', v_private_notes,
      'private_notes_visible_to_agents', false,
      'currency_code', 'USD'
    )
  );

  return (
    select jsonb_build_object(
      'payroll_item_id', v_item.id,
      'action', v_action,
      'gross_pay', record.gross_pay,
      'total_deductions', record.total_deductions,
      'net_pay', record.net_pay,
      'currency_code', record.currency_code
    )
    from public.payroll_records as record
    where record.id = v_record.id
  );
end;
$$;

revoke all on function public.payroll_save_adjustment(
  uuid, uuid, text, text, numeric, text, text
) from public, anon;
grant execute on function public.payroll_save_adjustment(
  uuid, uuid, text, text, numeric, text, text
) to authenticated, service_role;

comment on function public.payroll_save_adjustment(
  uuid, uuid, text, text, numeric, text, text
) is
  'Adds or edits one audited manual earning or deduction. Requires create_payroll and an editable calculated record.';

create or replace function public.payroll_remove_adjustment(
  p_payroll_item_id uuid,
  p_removal_reason text,
  p_correction_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_item public.payroll_items%rowtype;
  v_record public.payroll_records%rowtype;
  v_period_status text;
  v_reason text := trim(coalesce(p_removal_reason, ''));
  v_private_notes text := nullif(trim(coalesce(p_correction_notes, '')), '');
  v_before_data jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to manage payroll adjustments.';
  end if;

  if p_payroll_item_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll adjustment is required.';
  end if;

  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception
      using
        errcode = '22023',
        message = 'Removal reason must be 3 to 500 characters.';
  end if;

  if v_private_notes is not null and length(v_private_notes) > 2000 then
    raise exception
      using
        errcode = '22023',
        message = 'Private correction notes cannot exceed 2,000 characters.';
  end if;

  select item.*
  into v_item
  from public.payroll_items as item
  where item.id = p_payroll_item_id
  for update;

  if not found or not v_item.is_manual then
    raise exception
      using
        errcode = 'P0002',
        message = 'Manual payroll adjustment was not found.';
  end if;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = v_item.payroll_record_id
  for update;

  select period.status
  into v_period_status
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id
  for update;

  if v_period_status not in ('draft', 'reopened')
     or v_record.status in ('approved', 'finalized', 'void') then
    raise exception
      using
        errcode = '55000',
        message = 'Adjustments are allowed only while payroll is editable.';
  end if;

  v_before_data := jsonb_build_object(
    'item_type', v_item.item_type,
    'item_code', v_item.item_code,
    'description', v_item.description,
    'amount', v_item.amount,
    'adjustment_reason', v_item.adjustment_reason,
    'adjustment_version',
      coalesce((v_item.metadata ->> 'adjustment_version')::integer, 1)
  );

  delete from public.payroll_items
  where id = v_item.id;

  perform public.payroll_rebuild_record_totals(v_record.id);

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    payroll_record_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_adjustment_removed',
    'payroll_adjustment',
    v_item.id,
    v_record.payroll_period_id,
    v_record.id,
    v_before_data,
    null,
    v_reason,
    jsonb_build_object(
      'private_correction_notes', v_private_notes,
      'private_notes_visible_to_agents', false,
      'currency_code', 'USD'
    )
  );

  return (
    select jsonb_build_object(
      'payroll_item_id', v_item.id,
      'action', 'payroll_adjustment_removed',
      'gross_pay', record.gross_pay,
      'total_deductions', record.total_deductions,
      'net_pay', record.net_pay,
      'currency_code', record.currency_code
    )
    from public.payroll_records as record
    where record.id = v_record.id
  );
end;
$$;

revoke all on function public.payroll_remove_adjustment(uuid, text, text)
  from public, anon;
grant execute on function public.payroll_remove_adjustment(uuid, text, text)
  to authenticated, service_role;

comment on function public.payroll_remove_adjustment(uuid, text, text) is
  'Removes one manual adjustment from editable payroll, rebuilds totals, and preserves the complete private audit event.';

create or replace function public.payroll_get_period_adjustments(
  p_payroll_period_id uuid
)
returns table (
  payroll_item_id uuid,
  payroll_record_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  item_type text,
  description text,
  amount numeric,
  adjustment_reason text,
  private_correction_notes text,
  adjustment_version integer,
  created_by_name text,
  created_at timestamptz,
  last_changed_by_name text,
  last_changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view payroll adjustments.';
  end if;

  return query
  select
    item.id,
    record.id,
    record.employee_id,
    employee.full_name,
    employee.employee_id,
    employee.email,
    item.item_type,
    item.description,
    item.amount,
    item.adjustment_reason,
    latest_audit.metadata ->> 'private_correction_notes',
    coalesce(
      (item.metadata ->> 'adjustment_version')::integer,
      1
    ),
    creator.full_name,
    item.created_at,
    latest_actor.full_name,
    latest_audit.created_at
  from public.payroll_items as item
  join public.payroll_records as record
    on record.id = item.payroll_record_id
  join public.profiles as employee
    on employee.user_id = record.employee_id
  left join public.profiles as creator
    on creator.user_id = item.created_by
  left join lateral (
    select audit.*
    from public.payroll_audit_logs as audit
    where audit.entity_type = 'payroll_adjustment'
      and audit.entity_id = item.id
      and audit.action in (
        'payroll_adjustment_added',
        'payroll_adjustment_updated'
      )
    order by audit.created_at desc, audit.id desc
    limit 1
  ) as latest_audit on true
  left join public.profiles as latest_actor
    on latest_actor.user_id = latest_audit.actor_user_id
  where record.payroll_period_id = p_payroll_period_id
    and item.is_manual
    and record.calculated_at is not null
    and record.status <> 'void'
  order by
    employee.full_name,
    employee.email,
    item.created_at,
    item.id;
end;
$$;

revoke all on function public.payroll_get_period_adjustments(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_adjustments(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_adjustments(uuid) is
  'Payroll-processor-only current adjustment list, including private correction notes from the latest immutable audit event.';

commit;
