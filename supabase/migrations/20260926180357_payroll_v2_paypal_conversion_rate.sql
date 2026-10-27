begin;

alter table public.payroll_v2_periods
  add column paypal_conversion_rate numeric,
  add constraint payroll_v2_periods_paypal_conversion_rate_check
    check (paypal_conversion_rate is null or paypal_conversion_rate > 0);

comment on column public.payroll_v2_periods.paypal_conversion_rate is
  'Manually entered PayPal conversion rate applicable to this Payroll V2 period. Informational only; it never affects payroll calculations.';

-- Keep the original three-argument create RPC available for clients that have
-- not yet deployed the optional period-level rate field.
create function public.payroll_v2_create_period(
  p_period_start date,
  p_period_end date,
  p_payment_date date,
  p_paypal_conversion_rate numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period jsonb;
  v_period_id uuid;
begin
  if p_paypal_conversion_rate is not null and p_paypal_conversion_rate <= 0 then
    raise exception using errcode = '22023',
      message = 'PayPal Conversion Rate must be greater than zero.';
  end if;

  v_period := public.payroll_v2_create_period(
    p_period_start,
    p_period_end,
    p_payment_date
  );
  v_period_id := (v_period ->> 'period_id')::uuid;

  update public.payroll_v2_periods
  set paypal_conversion_rate = p_paypal_conversion_rate
  where id = v_period_id;

  return v_period || pg_catalog.jsonb_build_object(
    'paypal_conversion_rate', p_paypal_conversion_rate::text
  );
end;
$function$;

revoke all on function public.payroll_v2_create_period(date, date, date, numeric)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_create_period(date, date, date, numeric)
  to authenticated, service_role;
comment on function public.payroll_v2_create_period(date, date, date, numeric) is
  'Creates a Payroll V2 period with an optional manually entered informational PayPal conversion rate; no employee records or calculations are created.';

create function public.payroll_v2_set_period_paypal_conversion_rate(
  p_payroll_v2_period_id uuid,
  p_paypal_conversion_rate numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_saved_rate numeric;
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to update a Payroll V2 period.';
  end if;

  if p_payroll_v2_period_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period ID is required.';
  end if;

  if p_paypal_conversion_rate is not null and p_paypal_conversion_rate <= 0 then
    raise exception using errcode = '22023',
      message = 'PayPal Conversion Rate must be greater than zero.';
  end if;

  update public.payroll_v2_periods
  set paypal_conversion_rate = p_paypal_conversion_rate
  where id = p_payroll_v2_period_id
    and status <> 'void'
  returning paypal_conversion_rate into v_saved_rate;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'The Payroll V2 period is unavailable or void.';
  end if;

  return pg_catalog.jsonb_build_object(
    'period_id', p_payroll_v2_period_id,
    'paypal_conversion_rate', v_saved_rate::text
  );
end;
$function$;

revoke all on function public.payroll_v2_set_period_paypal_conversion_rate(uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_set_period_paypal_conversion_rate(uuid, numeric)
  to authenticated, service_role;
comment on function public.payroll_v2_set_period_paypal_conversion_rate(uuid, numeric) is
  'Updates only the informational PayPal conversion rate on one non-void Payroll V2 period; it does not reopen or recalculate payroll records.';

-- Add a rate-aware listing RPC and preserve the existing list contract for
-- clients that have not yet deployed the optional period metadata field.
create function public.payroll_v2_list_periods_with_rate()
returns table (
  period_id uuid,
  period_start date,
  period_end date,
  payment_date date,
  status text,
  created_at timestamptz,
  paypal_conversion_rate text,
  payslip_count bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception
      using errcode = '42501',
        message = 'You do not have permission to view Payroll Dashboard V2.';
  end if;

  return query
  select
    period.id,
    period.period_start,
    period.period_end,
    period.payment_date,
    period.status,
    period.created_at,
    period.paypal_conversion_rate::text,
    0::bigint
  from public.payroll_v2_periods as period
  order by period.period_start desc, period.created_at desc;
end;
$function$;

revoke all on function public.payroll_v2_list_periods_with_rate()
  from public, anon, authenticated;
grant execute on function public.payroll_v2_list_periods_with_rate()
  to authenticated, service_role;
comment on function public.payroll_v2_list_periods_with_rate() is
  'Lists Payroll V2 periods and their manually saved period-level PayPal conversion rates for payroll-authorized users.';

-- Agent list payslips stay based on persisted totals and additionally expose
-- the rate joined from the authoritative period row.
create or replace function public.payroll_v2_list_my_payslips()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_result jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication is required to view Payroll V2 payslips.';
  end if;

  if not public.workforce_has_permission('view_own_payslips') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view your Payroll V2 payslips.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'payroll_v2_record_id', record.id,
        'status', pg_catalog.initcap(record.status),
        'period_start', period.period_start,
        'period_end', period.period_end,
        'payment_date', period.payment_date,
        'paypal_conversion_rate', period.paypal_conversion_rate::text,
        'currency_code', record.calculation_snapshot ->> 'currency_code',
        'total_payable_minutes', record.calculation_snapshot -> 'total_payable_minutes',
        'gross_pay', record.calculation_snapshot -> 'gross_pay',
        'total_deductions', record.calculation_snapshot -> 'total_deductions',
        'net_pay', record.calculation_snapshot -> 'net_pay',
        'approved_at', record.approved_at,
        'finalized_at', record.finalized_at,
        'recalculation_pending', record.recalculation_pending_at is not null
      )
      order by period.payment_date desc nulls last,
        period.period_end desc, record.approved_at desc, record.id
    ),
    '[]'::jsonb
  )
  into v_result
  from public.payroll_v2_records record
  join public.payroll_v2_periods period
    on period.id = record.payroll_v2_period_id
  where public.workforce_is_current_identity(record.employee_user_id)
    and record.status in ('approved', 'finalized')
    and (
      record.status = 'finalized'
      or (
        record.status = 'approved'
        and record.recalculation_pending_at is null
        and record.recalculation_pending_by is null
        and record.recalculation_pending_reason is null
      )
    )
    and record.calculation_snapshot ->> 'ready_to_preview' = 'true'
    and record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
      = record.employee_user_id::text
    and record.calculation_snapshot -> 'period' ->> 'period_id'
      = record.payroll_v2_period_id::text
    and jsonb_typeof(record.calculation_snapshot -> 'gross_pay') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'total_deductions') = 'number'
    and jsonb_typeof(record.calculation_snapshot -> 'net_pay') = 'number';

  return v_result;
end;
$function$;

revoke all on function public.payroll_v2_list_my_payslips()
  from public, anon, authenticated;
grant execute on function public.payroll_v2_list_my_payslips()
  to authenticated, service_role;
comment on function public.payroll_v2_list_my_payslips() is
  'Lists the current employee identity''s approved or finalized Payroll V2 records using persisted totals and each period''s informational PayPal conversion rate.';

-- Add the period rate to the already-authorized persisted payslip readers.
-- The record status/ownership checks and saved totals/items remain unchanged.
create or replace function public.payroll_v2_get_my_payslip(p_payroll_v2_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payslip jsonb;
  v_hire_date date;
  v_paypal_conversion_rate numeric;
begin
  v_payslip := public.payroll_v2_get_my_payslip_persisted_base(p_payroll_v2_record_id);
  if v_payslip is null then
    return null;
  end if;

  select profile.hire_date, period.paypal_conversion_rate
    into v_hire_date, v_paypal_conversion_rate
  from public.payroll_v2_records record
  join public.profiles profile on profile.user_id = record.employee_user_id
  join public.payroll_v2_periods period on period.id = record.payroll_v2_period_id
  where record.id = p_payroll_v2_record_id;

  if not found then
    return null;
  end if;

  v_payslip := pg_catalog.jsonb_set(
    v_payslip,
    '{employee,hire_date}',
    coalesce(pg_catalog.to_jsonb(v_hire_date), 'null'::jsonb),
    true
  );
  return pg_catalog.jsonb_set(
    v_payslip,
    '{period,paypal_conversion_rate}',
    coalesce(pg_catalog.to_jsonb(v_paypal_conversion_rate::text), 'null'::jsonb),
    true
  );
end;
$function$;

create or replace function public.payroll_v2_get_admin_completed_payslip(p_payroll_v2_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payslip jsonb;
  v_hire_date date;
  v_paypal_conversion_rate numeric;
begin
  v_payslip := public.payroll_v2_get_admin_completed_payslip_persisted_base(p_payroll_v2_record_id);
  if v_payslip is null then
    return null;
  end if;

  select profile.hire_date, period.paypal_conversion_rate
    into v_hire_date, v_paypal_conversion_rate
  from public.payroll_v2_records record
  join public.profiles profile on profile.user_id = record.employee_user_id
  join public.payroll_v2_periods period on period.id = record.payroll_v2_period_id
  where record.id = p_payroll_v2_record_id;

  if not found then
    return null;
  end if;

  v_payslip := pg_catalog.jsonb_set(
    v_payslip,
    '{employee,hire_date}',
    coalesce(pg_catalog.to_jsonb(v_hire_date), 'null'::jsonb),
    true
  );
  return pg_catalog.jsonb_set(
    v_payslip,
    '{period,paypal_conversion_rate}',
    coalesce(pg_catalog.to_jsonb(v_paypal_conversion_rate::text), 'null'::jsonb),
    true
  );
end;
$function$;

revoke all on function public.payroll_v2_get_my_payslip(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_v2_get_my_payslip(uuid)
  to authenticated, service_role;
revoke all on function public.payroll_v2_get_admin_completed_payslip(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_v2_get_admin_completed_payslip(uuid)
  to authenticated, service_role;
comment on function public.payroll_v2_get_my_payslip(uuid) is
  'Returns the current employee''s authorized persisted Payroll V2 payslip, profile hire date, and period-level PayPal conversion rate.';
comment on function public.payroll_v2_get_admin_completed_payslip(uuid) is
  'Returns an authorized read-only persisted Payroll V2 payslip, profile hire date, and period-level PayPal conversion rate.';

notify pgrst, 'reload schema';

commit;

;
