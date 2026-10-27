-- Add the employee-level calculated -> approved transition to detached V2.
-- Approval changes lifecycle metadata only; saved calculation data is immutable.

alter table public.payroll_v2_records
  add column if not exists approved_by uuid
    references public.profiles(user_id) on delete restrict;

alter table public.payroll_v2_records
  drop constraint if exists payroll_v2_records_approval_actor_check;
alter table public.payroll_v2_records
  add constraint payroll_v2_records_approval_actor_check
  check (status not in ('approved', 'finalized') or approved_by is not null);

create or replace function public.payroll_v2_approve_employee(
  p_payroll_v2_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_record public.payroll_v2_records%rowtype;
  v_period_status text;
  v_actor_id uuid;
  v_actor_name text;
  v_approved_at timestamptz := statement_timestamp();
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('review_payroll') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to approve Payroll V2 employee pay.';
  end if;

  v_actor_id := public.workforce_current_profile_id();
  if v_actor_id is null then
    raise exception using errcode = '42501',
      message = 'The authenticated payroll approver could not be resolved.';
  end if;
  select profile.full_name into v_actor_name
  from public.profiles profile
  where profile.user_id = v_actor_id;

  select period.status into v_period_status
  from public.payroll_v2_periods period
  where period.id = (
    select record.payroll_v2_period_id
    from public.payroll_v2_records record
    where record.id = p_payroll_v2_record_id
  )
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 employee record was not found.';
  end if;

  select record.* into v_record
  from public.payroll_v2_records record
  where record.id = p_payroll_v2_record_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 employee record was not found.';
  end if;
  if lower(coalesce(v_period_status, '')) = 'void' then
    raise exception using errcode = '55000',
      message = 'A void payroll period cannot be approved.';
  end if;
  if v_record.status = 'approved' then
    raise exception using errcode = '23505',
      message = 'Payroll is already approved.';
  end if;
  if v_record.status <> 'calculated' then
    raise exception using errcode = '55000',
      message = 'Only a calculated Payroll V2 employee record can be approved.';
  end if;

  if jsonb_typeof(v_record.calculation_snapshot) <> 'object'
     or v_record.calculation_snapshot = '{}'::jsonb
     or v_record.calculation_snapshot ->> 'ready_to_preview' <> 'true'
     or v_record.calculation_snapshot -> 'employee' ->> 'employee_user_id'
          <> v_record.employee_user_id::text
     or v_record.calculation_snapshot -> 'period' ->> 'period_id'
          <> v_record.payroll_v2_period_id::text
     or jsonb_typeof(v_record.calculation_snapshot -> 'daily_breakdown') <> 'array'
     or jsonb_typeof(v_record.calculation_snapshot -> 'total_payable_minutes') <> 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'attendance_earnings') <> 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'paid_leave_earnings') <> 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'gross_pay') <> 'number'
     or jsonb_typeof(v_record.calculation_snapshot -> 'net_pay') <> 'number' then
    raise exception using errcode = '55000',
      message = 'The calculated Payroll V2 record has no valid persisted calculation data.';
  end if;

  update public.payroll_v2_records record
  set status = 'approved',
      approved_at = v_approved_at,
      approved_by = v_actor_id,
      updated_at = v_approved_at
  where record.id = v_record.id
  returning record.* into v_record;

  -- payroll_audit_logs is the existing append-only payroll lifecycle audit
  -- mechanism. V2 identity is stored in entity_type/entity_id; V1 foreign-key
  -- columns remain NULL.
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
    'payroll_v2_employee_approved',
    'payroll_v2_record',
    v_record.id,
    jsonb_build_object('status', 'calculated'),
    jsonb_build_object(
      'status', 'approved',
      'approved_at', v_record.approved_at,
      'approved_by', v_actor_id
    ),
    jsonb_build_object(
      'payroll_v2_period_id', v_record.payroll_v2_period_id,
      'employee_user_id', v_record.employee_user_id,
      'calculated_at', v_record.calculated_at
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
    'approved_by_name', v_actor_name
  );
end;
$function$;

revoke all on function public.payroll_v2_approve_employee(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_approve_employee(uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_approve_employee(uuid) is
  'Approves one existing calculated Payroll V2 record without recalculating or changing its saved items or snapshots.';

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
    and audit.action = 'payroll_v2_employee_approved';

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
  to authenticated, service_role;;
