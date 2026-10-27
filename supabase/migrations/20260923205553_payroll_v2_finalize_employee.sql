-- Complete the employee-level Payroll V2 lifecycle with an immutable,
-- approved -> finalized transition. The saved calculation is the only source.

alter table public.payroll_v2_records
  add column if not exists finalized_by uuid
    references public.profiles(user_id) on delete restrict;

alter table public.payroll_v2_records
  drop constraint if exists payroll_v2_records_finalization_actor_check;
alter table public.payroll_v2_records
  add constraint payroll_v2_records_finalization_actor_check
  check (status <> 'finalized' or finalized_by is not null);

create or replace function public.payroll_v2_finalize_employee(
  p_payroll_v2_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_period_id uuid;
  v_period public.payroll_v2_periods%rowtype;
  v_record public.payroll_v2_records%rowtype;
  v_actor_id uuid;
  v_actor_name text;
  v_finalized_at timestamptz := statement_timestamp();
  v_deductions numeric(14,2);
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('finalize_payroll') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to finalize Payroll V2 employee pay.';
  end if;

  v_actor_id := public.workforce_current_profile_id();
  if v_actor_id is null then
    raise exception using errcode = '42501',
      message = 'The authenticated payroll finalizer could not be resolved.';
  end if;

  if p_payroll_v2_record_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 record ID is required.';
  end if;

  -- Every V2 lifecycle mutation takes the parent-period lock before the
  -- record lock. This serializes finalization with calculation/approval and
  -- prevents duplicate transitions from concurrent requests.
  select record.payroll_v2_period_id into v_period_id
  from public.payroll_v2_records record
  where record.id = p_payroll_v2_record_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 employee record was not found.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = v_period_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period was not found.';
  end if;

  select record.* into v_record
  from public.payroll_v2_records record
  where record.id = p_payroll_v2_record_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 employee record was not found.';
  end if;

  if lower(coalesce(v_period.status, '')) = 'void' then
    raise exception using errcode = '55000',
      message = 'A void payroll period cannot be finalized.';
  end if;
  if v_record.status = 'finalized' then
    raise exception using errcode = '23505',
      message = 'Payroll is already finalized.';
  end if;
  if v_record.status <> 'approved' then
    raise exception using errcode = '55000',
      message = 'Only an approved Payroll V2 employee record can be finalized.';
  end if;
  if v_record.recalculation_pending_at is not null
     or v_record.recalculation_pending_by is not null
     or v_record.recalculation_pending_reason is not null then
    raise exception using errcode = '55000',
      message = 'Payroll cannot be finalized while a recalculation/edit window is open.';
  end if;
  if v_record.approved_at is null or v_record.approved_by is null
     or v_record.finalized_at is not null or v_record.finalized_by is not null then
    raise exception using errcode = '55000',
      message = 'The approved Payroll V2 lifecycle metadata is incomplete or inconsistent.';
  end if;

  -- Fail closed if the approved saved result is incomplete. No source tables
  -- or live calculation RPCs are read or called during finalization.
  if jsonb_typeof(v_record.calculation_snapshot) is distinct from 'object'
     or v_record.calculation_snapshot = '{}'::jsonb
     or v_record.calculation_snapshot ->> 'ready_to_preview' is distinct from 'true'
     or v_record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
          is distinct from v_record.employee_user_id::text
     or v_record.calculation_snapshot -> 'period' ->> 'period_id'
          is distinct from v_record.payroll_v2_period_id::text
     or jsonb_typeof(v_record.calculation_snapshot -> 'total_payable_minutes') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'attendance_earnings') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'paid_leave_earnings') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'gross_pay') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'total_deductions') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'net_pay') is distinct from 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'daily_breakdown') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'The approved Payroll V2 record has no valid persisted calculation data.';
  end if;

  v_deductions := (v_record.calculation_snapshot ->> 'total_deductions')::numeric;
  select profile.full_name into v_actor_name
  from public.profiles profile
  where profile.user_id = v_actor_id;

  update public.payroll_v2_records record
  set status = 'finalized',
      finalized_at = v_finalized_at,
      finalized_by = v_actor_id,
      updated_at = v_finalized_at
  where record.id = v_record.id
  returning record.* into v_record;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    metadata
  ) values (
    v_actor_id,
    'payroll_v2_employee_finalized',
    'payroll_v2_record',
    v_record.id,
    jsonb_build_object(
      'status', 'approved',
      'approved_at', v_record.approved_at,
      'approved_by', v_record.approved_by,
      'finalized_at', null,
      'finalized_by', null
    ),
    jsonb_build_object(
      'status', 'finalized',
      'finalized_at', v_record.finalized_at,
      'finalized_by', v_actor_id
    ),
    jsonb_build_object(
      'payroll_v2_record_id', v_record.id,
      'payroll_v2_period_id', v_record.payroll_v2_period_id,
      'employee_user_id', v_record.employee_user_id,
      'gross_pay', v_record.calculation_snapshot -> 'gross_pay',
      'deductions', v_deductions,
      'net_pay', v_record.calculation_snapshot -> 'net_pay'
    )
  );

  return jsonb_build_object(
    'payroll_v2_record_id', v_record.id,
    'payroll_v2_period_id', v_record.payroll_v2_period_id,
    'employee_user_id', v_record.employee_user_id,
    'record_status', v_record.status,
    'calculated_at', v_record.calculated_at,
    'approved_at', v_record.approved_at,
    'approved_by', v_record.approved_by,
    'finalized_at', v_record.finalized_at,
    'finalized_by', v_record.finalized_by,
    'finalized_by_name', v_actor_name
  );
end;
$function$;

revoke all on function public.payroll_v2_finalize_employee(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_finalize_employee(uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_finalize_employee(uuid) is
  'Finalizes exactly one already-approved Payroll V2 calculation without recalculating or changing its saved items or snapshots.';

create or replace function public.payroll_v2_get_calculated_employee(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_record public.payroll_v2_records%rowtype;
  v_items jsonb;
  v_attendance_snapshots jsonb;
  v_commitment_snapshots jsonb;
  v_approved_by_name text;
  v_finalized_by_name text;
  v_status_history jsonb;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
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
      message = 'You do not have permission to view Payroll Dashboard V2 employee pay.';
  end if;

  select record.* into v_record
  from public.payroll_v2_records record
  where record.payroll_v2_period_id = p_payroll_v2_period_id
    and record.employee_user_id = p_employee_user_id
    and record.status <> 'void';
  if not found then return null; end if;

  select profile.full_name into v_approved_by_name
  from public.profiles profile
  where profile.user_id = v_record.approved_by;
  select profile.full_name into v_finalized_by_name
  from public.profiles profile
  where profile.user_id = v_record.finalized_by;

  select coalesce(jsonb_agg(to_jsonb(item) - 'created_at' order by item.work_date nulls last, item.created_at, item.id), '[]'::jsonb)
    into v_items
  from public.payroll_v2_items item
  where item.payroll_v2_record_id = v_record.id;
  select coalesce(jsonb_agg(to_jsonb(snapshot) - 'created_at' order by snapshot.work_date, snapshot.id), '[]'::jsonb)
    into v_attendance_snapshots
  from public.payroll_v2_attendance_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id;
  select coalesce(jsonb_agg(to_jsonb(snapshot) - 'created_at' order by snapshot.work_date, snapshot.id), '[]'::jsonb)
    into v_commitment_snapshots
  from public.payroll_v2_committed_hours_snapshots snapshot
  where snapshot.payroll_v2_record_id = v_record.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'action', audit.action,
    'previous_status', audit.before_data ->> 'status',
    'new_status', audit.after_data ->> 'status',
    'actor_user_id', audit.actor_user_id,
    'actor_name', actor.full_name,
    'changed_at', audit.created_at
  ) order by audit.created_at, audit.id), '[]'::jsonb)
    into v_status_history
  from public.payroll_audit_logs audit
  left join public.profiles actor on actor.user_id = audit.actor_user_id
  where audit.entity_type = 'payroll_v2_record'
    and audit.entity_id = v_record.id
    and audit.action in ('payroll_v2_employee_approved', 'payroll_v2_employee_finalized');

  return v_record.calculation_snapshot || jsonb_build_object(
    'status', pg_catalog.initcap(v_record.status),
    'persistence', jsonb_build_object(
      'saved', true,
      'payroll_v2_record_id', v_record.id,
      'record_status', v_record.status,
      'calculated_at', v_record.calculated_at,
      'approved_at', v_record.approved_at,
      'approved_by', v_record.approved_by,
      'approved_by_name', v_approved_by_name,
      'finalized_at', v_record.finalized_at,
      'finalized_by', v_record.finalized_by,
      'finalized_by_name', v_finalized_by_name,
      'recalculation_pending', v_record.recalculation_pending_at is not null,
      'recalculation_pending_at', v_record.recalculation_pending_at,
      'recalculation_pending_by', v_record.recalculation_pending_by,
      'recalculation_pending_reason', v_record.recalculation_pending_reason,
      'message', 'Payroll V2 result loaded from its saved calculation and snapshots.'
    ),
    'status_history', v_status_history,
    'items', v_items,
    'attendance_snapshots', v_attendance_snapshots,
    'committed_hours_snapshots', v_commitment_snapshots
  );
end;
$function$;

revoke all on function public.payroll_v2_get_calculated_employee(uuid, uuid)
  from public, anon;
grant execute on function public.payroll_v2_get_calculated_employee(uuid, uuid)
  to authenticated, service_role;

;
