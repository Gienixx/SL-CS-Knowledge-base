-- Check both sides of attempted record/item moves so finalized payroll cannot
-- be bypassed by changing a foreign key to an editable period.

begin;

create or replace function public.payroll_guard_finalized_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_finalized boolean := false;
  v_new_finalized boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select period.status = 'finalized'
    into v_old_finalized
    from public.payroll_records as record
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where record.id = old.payroll_record_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select period.status = 'finalized'
    into v_new_finalized
    from public.payroll_records as record
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where record.id = new.payroll_record_id;
  end if;

  if coalesce(v_old_finalized, false)
     or coalesce(v_new_finalized, false) then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized payroll details are immutable. Use controlled reopening.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.payroll_guard_finalized_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_finalized boolean := false;
  v_new_finalized boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select period.status = 'finalized'
    into v_old_finalized
    from public.payroll_periods as period
    where period.id = old.payroll_period_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select period.status = 'finalized'
    into v_new_finalized
    from public.payroll_periods as period
    where period.id = new.payroll_period_id;
  end if;

  if coalesce(v_old_finalized, false)
     or coalesce(v_new_finalized, false) then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized payroll records are immutable. Use controlled reopening.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.payroll_guard_finalized_child()
  from public, anon, authenticated;
revoke all on function public.payroll_guard_finalized_record()
  from public, anon, authenticated;
grant execute on function public.payroll_guard_finalized_child()
  to service_role;
grant execute on function public.payroll_guard_finalized_record()
  to service_role;

commit;
