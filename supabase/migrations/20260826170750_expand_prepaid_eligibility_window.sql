-- Expand prepaid eligibility from the post-payment portion of a period to
-- the ten calendar days ending on the payroll cutoff. Keep the existing
-- schedule, permission, approval, reconciliation, and lock rules intact.

begin;

create or replace function public.payroll_prepaid_eligibility_start(
  p_period_end date
)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select p_period_end - 10;
$$;

revoke all on function public.payroll_prepaid_eligibility_start(date)
  from public, anon;
grant execute on function public.payroll_prepaid_eligibility_start(date)
  to authenticated, service_role;

comment on function public.payroll_prepaid_eligibility_start(date) is
  'Returns the inclusive first work date in the ten-calendar-day prepaid window ending on the payroll cutoff.';

alter table public.payroll_periods
  alter column early_payment_window_days set default 10;

comment on column public.payroll_periods.early_payment_window_days is
  'Standard early-payment window captured on the period; currently ten calendar days.';

do $migration$
declare
  v_definition text;
begin
  -- Keep the period-creation policy and its audit metadata aligned with the
  -- new standard without duplicating the existing security and overlap logic.
  select replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_create_period(date,date,date,text)'::regprocedure
    ),
    chr(13),
    ''
  )
  into v_definition;

  if position('v_early_payment_days > 3' in v_definition) = 0
     or position('v_early_payment_days <= 3' in v_definition) = 0
     or position(E'    3,\n    v_override_reason,' in v_definition) = 0 then
    raise exception 'payroll_create_period no longer contains the expected three-day policy';
  end if;

  v_definition := replace(
    v_definition,
    'v_early_payment_days > 3',
    'v_early_payment_days > 10'
  );
  v_definition := replace(
    v_definition,
    'v_early_payment_days <= 3',
    'v_early_payment_days <= 10'
  );
  v_definition := replace(
    v_definition,
    E'    3,\n    v_override_reason,',
    E'    10,\n    v_override_reason,'
  );
  v_definition := replace(
    v_definition,
    'Payment more than 3 days before cutoff requires a documented override reason.',
    'Payment more than 10 days before cutoff requires a documented override reason.'
  );
  execute v_definition;

  -- Candidate discovery and bulk approval must share the exact same date
  -- boundary as the single-entry RPC.
  select replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_get_preplot_candidates(uuid)'::regprocedure
    ),
    chr(13),
    ''
  )
  into v_definition;
  if position('schedule.shift_date > v_period.payment_date' in v_definition) = 0 then
    raise exception 'payroll_get_preplot_candidates no longer contains the expected payment-date boundary';
  end if;
  v_definition := replace(
    v_definition,
    'schedule.shift_date > v_period.payment_date',
    'schedule.shift_date >= public.payroll_prepaid_eligibility_start(v_period.period_end)'
  );
  execute v_definition;

  select replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_approve_preplots(uuid,uuid[],text)'::regprocedure
    ),
    chr(13),
    ''
  )
  into v_definition;
  if position('schedule.shift_date <= v_period.payment_date' in v_definition) = 0 then
    raise exception 'payroll_approve_preplots no longer contains the expected payment-date boundary';
  end if;
  v_definition := replace(
    v_definition,
    'schedule.shift_date <= v_period.payment_date',
    'schedule.shift_date < public.payroll_prepaid_eligibility_start(v_period.period_end)'
  );
  v_definition := replace(
    v_definition,
    'The schedule is outside the post-payment portion of this payroll period.',
    'The schedule is outside the ten-calendar-day prepaid window ending on the payroll cutoff.'
  );
  execute v_definition;

  select replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_save_and_approve_prepaid_schedule(uuid,uuid,date,time without time zone,time without time zone,text,text,boolean)'::regprocedure
    ),
    chr(13),
    ''
  )
  into v_definition;
  if position('p_work_date <= v_period.payment_date' in v_definition) = 0 then
    raise exception 'payroll_save_and_approve_prepaid_schedule no longer contains the expected payment-date boundary';
  end if;
  v_definition := replace(
    v_definition,
    'p_work_date <= v_period.payment_date',
    'p_work_date < public.payroll_prepaid_eligibility_start(v_period.period_end)'
  );
  v_definition := replace(
    v_definition,
    'The prepaid work date must be after payment and on or before the payroll cutoff.',
    'The prepaid work date must be within ten calendar days before and on the payroll cutoff.'
  );
  execute v_definition;
end;
$migration$;

commit;
