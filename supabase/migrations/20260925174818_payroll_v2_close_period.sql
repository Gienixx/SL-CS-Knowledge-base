-- A Payroll V2 period can be explicitly closed after every included payslip
-- has reached an approved or finalized state. Closing only locks membership;
-- it never changes employee-level payroll statuses or saved financial data.

alter table public.payroll_v2_periods
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles(user_id) on delete restrict;

alter table public.payroll_v2_periods
  drop constraint payroll_v2_periods_status_check;
alter table public.payroll_v2_periods
  add constraint payroll_v2_periods_status_check
  check (status in ('draft', 'review', 'approved', 'finalized', 'void', 'closed'));
alter table public.payroll_v2_periods
  add constraint payroll_v2_periods_closed_audit_check
  check (status <> 'closed' or (closed_at is not null and closed_by is not null));

create or replace function public.payroll_v2_get_period_close_state(
  p_payroll_v2_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_payslip_count bigint;
  v_approved_count bigint;
  v_finalized_count bigint;
  v_unfinished_count bigint;
  v_can_close boolean;
  v_reason text;
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
    raise exception using errcode = '42501',
      message = 'You do not have permission to view Payroll V2 period status.';
  end if;

  if p_payroll_v2_period_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period is required.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  select
    count(*) filter (where record.status <> 'void'),
    count(*) filter (where record.status = 'approved'),
    count(*) filter (where record.status = 'finalized'),
    count(*) filter (
      where record.status <> 'void'
        and (
          record.status not in ('approved', 'finalized')
          or record.recalculation_pending_at is not null
          or record.recalculation_pending_by is not null
          or record.recalculation_pending_reason is not null
        )
    )
  into v_payslip_count, v_approved_count, v_finalized_count, v_unfinished_count
  from public.payroll_v2_records record
  where record.payroll_v2_period_id = v_period.id;

  v_can_close := v_period.status not in ('void', 'closed')
    and v_payslip_count > 0
    and v_unfinished_count = 0;
  v_reason := case
    when v_period.status = 'closed' then null
    when v_period.status = 'void' then 'Void periods cannot be closed.'
    when v_payslip_count = 0 then 'Add at least one payslip before closing this period.'
    when v_unfinished_count > 0 then 'Finish or approve all payslips before closing this period.'
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
    'status', v_period.status,
    'payslip_count', v_payslip_count,
    'approved_count', v_approved_count,
    'finalized_count', v_finalized_count,
    'unfinished_count', v_unfinished_count,
    'close_eligible', v_can_close,
    'reason', v_reason,
    'closed_at', v_period.closed_at,
    'closed_by', v_period.closed_by
  );
end;
$function$;

create or replace function public.payroll_v2_close_period(
  p_payroll_v2_period_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_closed_at timestamptz := pg_catalog.statement_timestamp();
  v_payslip_count bigint;
  v_approved_count bigint;
  v_finalized_count bigint;
  v_unfinished_count bigint;
  v_before_data jsonb;
  v_after_data jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to close Payroll V2 periods.';
  end if;

  if p_payroll_v2_period_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period is required.';
  end if;

  -- This lock serializes closure with Payroll V2 calculation RPCs. The
  -- membership trigger below takes a conflicting share lock for direct writes.
  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  if v_period.status = 'closed' then
    return public.payroll_v2_get_period_close_state(v_period.id);
  end if;
  if v_period.status = 'void' then
    raise exception using errcode = '55000',
      message = 'A Void Payroll V2 period cannot be closed.';
  end if;

  select
    count(*) filter (where record.status <> 'void'),
    count(*) filter (where record.status = 'approved'),
    count(*) filter (where record.status = 'finalized'),
    count(*) filter (
      where record.status <> 'void'
        and (
          record.status not in ('approved', 'finalized')
          or record.recalculation_pending_at is not null
          or record.recalculation_pending_by is not null
          or record.recalculation_pending_reason is not null
        )
    )
  into v_payslip_count, v_approved_count, v_finalized_count, v_unfinished_count
  from public.payroll_v2_records record
  where record.payroll_v2_period_id = v_period.id;

  if v_payslip_count = 0 then
    raise exception using errcode = '55000',
      message = 'Add at least one payslip before closing this period.';
  end if;
  if v_unfinished_count > 0 then
    raise exception using errcode = '55000',
      message = 'Finish or approve all payslips before closing this period.';
  end if;

  v_before_data := pg_catalog.jsonb_build_object(
    'status', v_period.status,
    'payslip_count', v_payslip_count,
    'approved_count', v_approved_count,
    'finalized_count', v_finalized_count
  );

  update public.payroll_v2_periods period
  set status = 'closed',
      closed_at = v_closed_at,
      closed_by = v_actor_user_id
  where period.id = v_period.id
    and period.status not in ('closed', 'void')
  returning period.* into v_period;
  if not found then
    raise exception using errcode = '55000',
      message = 'Payroll V2 period could not be closed.';
  end if;

  v_after_data := pg_catalog.jsonb_build_object(
    'status', v_period.status,
    'closed_at', v_period.closed_at,
    'closed_by', v_period.closed_by,
    'payslip_count', v_payslip_count,
    'approved_count', v_approved_count,
    'finalized_count', v_finalized_count
  );

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    metadata
  ) values (
    v_actor_user_id,
    'payroll_v2_period_closed',
    'payroll_v2_period',
    v_period.id,
    v_before_data,
    v_after_data,
    pg_catalog.jsonb_build_object(
      'payroll_v2_period_id', v_period.id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'payment_date', v_period.payment_date
    )
  );

  return pg_catalog.jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
    'status', v_period.status,
    'payslip_count', v_payslip_count,
    'approved_count', v_approved_count,
    'finalized_count', v_finalized_count,
    'unfinished_count', 0,
    'close_eligible', false,
    'reason', null,
    'closed_at', v_period.closed_at,
    'closed_by', v_period.closed_by
  );
end;
$function$;

create or replace function public.payroll_v2_guard_closed_period_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_period_status text;
  v_old_period_status text;
  v_new_period_status text;
begin
  if tg_op = 'INSERT' then
    select period.status into v_period_status
    from public.payroll_v2_periods period
    where period.id = new.payroll_v2_period_id
    for share;
    if v_period_status = 'closed' then
      raise exception using errcode = '55000',
        message = 'Payslips cannot be added to a closed Payroll V2 period.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select period.status into v_period_status
    from public.payroll_v2_periods period
    where period.id = old.payroll_v2_period_id
    for share;
    if v_period_status = 'closed' then
      raise exception using errcode = '55000',
        message = 'Payslips cannot be removed from a closed Payroll V2 period.';
    end if;
    return old;
  end if;

  perform period.id
  from public.payroll_v2_periods period
  where period.id in (old.payroll_v2_period_id, new.payroll_v2_period_id)
  order by period.id
  for share;

  select period.status into v_old_period_status
  from public.payroll_v2_periods period
  where period.id = old.payroll_v2_period_id;
  select period.status into v_new_period_status
  from public.payroll_v2_periods period
  where period.id = new.payroll_v2_period_id;

  if v_old_period_status = 'closed' or v_new_period_status = 'closed' then
    raise exception using errcode = '55000',
      message = 'Payslips cannot be moved into or out of a closed Payroll V2 period.';
  end if;
  return new;
end;
$function$;

drop trigger if exists payroll_v2_records_guard_closed_period_insert
  on public.payroll_v2_records;
create trigger payroll_v2_records_guard_closed_period_insert
before insert on public.payroll_v2_records
for each row execute function public.payroll_v2_guard_closed_period_membership();

drop trigger if exists payroll_v2_records_guard_closed_period_delete
  on public.payroll_v2_records;
create trigger payroll_v2_records_guard_closed_period_delete
before delete on public.payroll_v2_records
for each row execute function public.payroll_v2_guard_closed_period_membership();

drop trigger if exists payroll_v2_records_guard_closed_period_membership_update
  on public.payroll_v2_records;
create trigger payroll_v2_records_guard_closed_period_membership_update
before update of payroll_v2_period_id, employee_user_id on public.payroll_v2_records
for each row execute function public.payroll_v2_guard_closed_period_membership();

revoke all on function public.payroll_v2_get_period_close_state(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_get_period_close_state(uuid)
  to authenticated, service_role;
revoke all on function public.payroll_v2_close_period(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_close_period(uuid)
  to authenticated, service_role;
revoke all on function public.payroll_v2_guard_closed_period_membership()
  from public, anon, authenticated;

comment on function public.payroll_v2_close_period(uuid) is
  'Closes Payroll V2 period membership only when every non-void payslip is approved/finalized. Does not change employee payroll records.';
comment on function public.payroll_v2_guard_closed_period_membership() is
  'Server-side guard preventing Payroll V2 payslip membership inserts, deletes, or moves for a closed period.';

;
