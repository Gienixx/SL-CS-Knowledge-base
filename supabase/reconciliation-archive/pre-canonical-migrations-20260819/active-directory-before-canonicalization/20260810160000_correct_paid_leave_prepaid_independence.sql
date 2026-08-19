begin;

-- Paid leave is an independent fixed entitlement.  Prepaid balances belong to
-- the worked/prepaid schedule workflow and must never reduce this source.
create or replace function public.payroll_apply_paid_leave_earnings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_leave record;
  v_rate record;
  v_minutes integer;
  v_amount numeric(14,2);
begin
  if new.calculated_at is null or new.status = 'void' then
    return new;
  end if;

  delete from public.payroll_items item
  where item.payroll_record_id = new.id
    and not item.is_manual
    and item.item_code = 'paid_leave_earnings';

  update public.payroll_records
  set paid_leave_minutes = 0,
      paid_leave_pay = 0
  where id = new.id;

  for v_leave in
    select distinct on (schedule.shift_date)
      schedule.shift_date,
      schedule.id,
      schedule.leave_type,
      schedule.leave_request_id
    from public.work_schedules schedule
    where schedule.user_id = new.employee_id
      and schedule.status in ('published', 'changed', 'completed')
      and schedule.is_leave
      and public.workforce_is_paid_leave_type(schedule.leave_type)
      and schedule.shift_date between
        (select period_start from public.payroll_periods where id = new.payroll_period_id)
        and (select period_end from public.payroll_periods where id = new.payroll_period_id)
    order by schedule.shift_date, schedule.updated_at desc, schedule.id
  loop
    -- Always pay the configured 8-hour paid-leave entitlement.  Do not query
    -- or deduct payroll_prepaid_hours here.
    v_minutes := 480;

    select rate.*
    into v_rate
    from public.agent_rates rate
    where rate.employee_id = new.employee_id
      and rate.effective_date <= v_leave.shift_date
    order by rate.effective_date desc
    limit 1;

    if not found then
      continue;
    end if;

    v_amount := round(v_minutes::numeric / 60 * v_rate.hourly_rate, 2);

    insert into public.payroll_items (
      payroll_record_id,
      item_type,
      item_code,
      description,
      quantity,
      unit_rate,
      amount,
      rate_id,
      work_date,
      source_schedule_id,
      calculation_version,
      metadata,
      created_by
    ) values (
      new.id,
      'earning',
      'paid_leave_earnings',
      'Approved paid leave — worked hours are additional',
      v_minutes::numeric / 60,
      v_rate.hourly_rate,
      v_amount,
      v_rate.id,
      v_leave.shift_date,
      v_leave.id,
      new.calculation_version,
      jsonb_build_object(
        'source', 'approved_paid_leave',
        'leave_type', v_leave.leave_type,
        'guaranteed_minutes', 480,
        'prepaid_independent', true,
        'premium_pay', false
      ),
      new.calculated_by
    );

    update public.payroll_records
    set paid_leave_minutes = paid_leave_minutes + v_minutes,
        paid_leave_pay = paid_leave_pay + v_amount
    where id = new.id;
  end loop;

  return new;
end;
$$;

revoke all on function public.payroll_apply_paid_leave_earnings()
  from public, anon, authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  null,
  'paid_leave_prepaid_independence_corrected',
  'attendance_payroll',
  jsonb_build_object(
    'paid_leave_minutes', 480,
    'prepaid_offset', false,
    'attendance_additional', true,
    'premium_pay', false
  ),
  'Corrected paid-leave entitlement so prepaid balances cannot reduce guaranteed leave pay'
);

commit;
