-- Payroll Dashboard V2 owns a separate period parent until its payslip
-- workflows are ready to share any lifecycle with the existing payroll app.
-- The existing payroll_create_period RPC intentionally creates payroll
-- record shells, so V2 must not call it.

create table public.payroll_v2_periods (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  payment_date date not null,
  status text not null default 'draft',
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payroll_v2_periods_dates_check
    check (period_end >= period_start),
  constraint payroll_v2_periods_status_check
    check (status in ('draft', 'review', 'approved', 'finalized', 'void'))
);

create index payroll_v2_periods_start_idx
  on public.payroll_v2_periods (period_start desc, created_at desc);

alter table public.payroll_v2_periods enable row level security;
revoke all on table public.payroll_v2_periods from public, anon, authenticated;
grant all on table public.payroll_v2_periods to service_role;

create or replace function public.payroll_v2_list_periods()
returns table (
  period_id uuid,
  period_start date,
  period_end date,
  payment_date date,
  status text,
  created_at timestamptz,
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
    0::bigint
  from public.payroll_v2_periods as period
  order by period.period_start desc, period.created_at desc;
end;
$function$;

create or replace function public.payroll_v2_create_period(
  p_period_start date,
  p_period_end date,
  p_payment_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_v2_periods%rowtype;
  v_overlap public.payroll_v2_periods%rowtype;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using errcode = '42501',
        message = 'You do not have permission to create Payroll Dashboard V2 periods.';
  end if;

  if p_period_start is null
     or p_period_end is null
     or p_payment_date is null then
    raise exception
      using errcode = '22023',
        message = 'Start Date, End Date, and Payment Date are required.';
  end if;

  if p_period_end < p_period_start then
    raise exception
      using errcode = '22023',
        message = 'End Date cannot be before Start Date.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_v2_periods:create', 0)
  );

  select period.*
  into v_overlap
  from public.payroll_v2_periods as period
  where period.status <> 'void'
    and daterange(period.period_start, period.period_end, '[]')
      && daterange(p_period_start, p_period_end, '[]')
  order by period.period_start
  limit 1;

  if found then
    raise exception
      using errcode = '23P01',
        message = pg_catalog.format(
          'This Payroll V2 period overlaps %s through %s.',
          pg_catalog.to_char(v_overlap.period_start, 'YYYY-MM-DD'),
          pg_catalog.to_char(v_overlap.period_end, 'YYYY-MM-DD')
        );
  end if;

  insert into public.payroll_v2_periods (
    period_start,
    period_end,
    payment_date,
    status,
    created_by
  )
  values (
    p_period_start,
    p_period_end,
    p_payment_date,
    'draft',
    v_actor_user_id
  )
  returning * into v_period;

  return pg_catalog.jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
    'status', v_period.status,
    'created_at', v_period.created_at,
    'payslip_count', 0
  );
end;
$function$;

revoke all on function public.payroll_v2_list_periods()
  from public, anon;
revoke all on function public.payroll_v2_create_period(date, date, date)
  from public, anon;
grant execute on function public.payroll_v2_list_periods()
  to authenticated, service_role;
grant execute on function public.payroll_v2_create_period(date, date, date)
  to authenticated, service_role;

comment on table public.payroll_v2_periods is
  'Detached Payroll Dashboard V2 period parents. Creating a row does not create payroll records, payslips, attendance snapshots, or earnings.';
comment on function public.payroll_v2_create_period(date, date, date) is
  'Creates only a Payroll Dashboard V2 period parent after payroll permission and date validation.';;
