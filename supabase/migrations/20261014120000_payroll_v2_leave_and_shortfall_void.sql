-- Follow-up to Payroll V2 shortfall reconciliation. Patch the deployed V2
-- calculation function only when its exact known implementation is present.
-- The dynamic replacement preserves its existing signature, ACL, and other
-- calculation behavior while using the saved leave request duration.
do $migration$
declare
  v_function_oid oid;
  v_source text;
  v_definition text;
  v_old_leave_fields constant text := $old$coalesce(nullif(schedule.leave_type, ''), request.leave_type) as leave_type,
      schedule.id as schedule_id$old$;
  v_new_leave_fields constant text := $new$coalesce(nullif(schedule.leave_type, ''), request.leave_type) as leave_type,
      coalesce(request.leave_duration, 'whole_day') as leave_duration,
      request.requested_leave_minutes,
      schedule.id as schedule_id$new$;
  v_old_paid_minutes constant text := $old$'paid_minutes', 480,$old$;
  v_new_paid_minutes constant text := $new$'paid_minutes',
      case
        when leave_date.leave_duration in ('half_day', 'specific_time')
          then coalesce(leave_date.requested_leave_minutes, 0)
        else 480
      end,$new$;
begin
  select function_row.oid, function_row.prosrc
  into v_function_oid, v_source
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'public'
    and function_row.proname = 'payroll_v2_employee_calculation_payload'
    and pg_catalog.pg_get_function_identity_arguments(function_row.oid) =
      'p_payroll_v2_period_id uuid, p_employee_user_id uuid';

  if v_function_oid is null then
    raise exception 'Expected Payroll V2 employee calculation function is missing.';
  end if;
  if pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_leave_fields, ''))
       <> pg_catalog.length(v_old_leave_fields)
     or pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_paid_minutes, ''))
       <> pg_catalog.length(v_old_paid_minutes) then
    raise exception 'Payroll V2 leave calculation differs from the verified patch baseline; no function was changed.';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_function_oid);
  v_definition := pg_catalog.replace(v_definition, v_old_leave_fields, v_new_leave_fields);
  v_definition := pg_catalog.replace(v_definition, v_old_paid_minutes, v_new_paid_minutes);
  execute v_definition;
end;
$migration$;

-- Add an audited, one-time, employee-specific void marker for the virtual
-- previous-cutoff shortfall. No payroll row or historical snapshot is edited.
do $migration$
declare
  v_function_oid oid;
  v_source text;
  v_definition text;
  v_old_prior_boundary constant text := $old$  v_coverage := public.payroll_get_expected_committed_hours_summary($old$;
  v_new_prior_boundary constant text := $new$  if exists (
    select 1
    from public.payroll_audit_logs audit
    where audit.action = 'payroll_v2_prior_committed_hours_shortfall_voided'
      and audit.entity_type = 'payroll_v2_committed_hours_shortfall'
      and audit.entity_id = v_prior.id
      and audit.metadata ->> 'current_period_id' = p_payroll_v2_period_id::text
      and audit.metadata ->> 'employee_user_id' = p_employee_user_id::text
  ) then
    return jsonb_build_object(
      'rows', '[]'::jsonb,
      'amount', 0,
      'count', 0,
      'rate_missing', false,
      'voided', true,
      'prior_period_id', v_prior.id,
      'prior_period_start', v_prior.period_start,
      'prior_period_end', v_prior.period_end
    );
  end if;

  select not exists (
    select 1
    from public.payroll_v2_records record
    where record.payroll_v2_period_id = p_payroll_v2_period_id
      and record.employee_user_id = p_employee_user_id
      and record.status <> 'void'
      and not (
        record.status = 'calculated'
        and record.recalculation_pending_at is not null
        and record.approved_at is null
        and record.finalized_at is null
      )
  )
  into v_can_void;

  if v_current.status <> 'draft' then
    v_can_void := false;
  end if;
  v_coverage := public.payroll_get_expected_committed_hours_summary($new$;
  v_old_void_declaration constant text := $old$v_rate_missing boolean := false;$old$;
  v_new_void_declaration constant text := $new$v_rate_missing boolean := false;
  v_can_void boolean := false;$new$;
  v_old_can_void constant text := $old$'can_void', false,$old$;
  v_new_can_void constant text := $new$'can_void', v_can_void,
      'requires_reason', true,$new$;
begin
  select function_row.oid, function_row.prosrc
  into v_function_oid, v_source
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'public'
    and function_row.proname = 'payroll_v2_prior_committed_hours_shortfall'
    and pg_catalog.pg_get_function_identity_arguments(function_row.oid) =
      'p_payroll_v2_period_id uuid, p_employee_user_id uuid';

  if v_function_oid is null then
    raise exception 'Expected reconciled Payroll V2 shortfall function is missing; apply PR #66 first.';
  end if;
  if pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_prior_boundary, ''))
       <> pg_catalog.length(v_old_prior_boundary)
     or pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_void_declaration, ''))
       <> pg_catalog.length(v_old_void_declaration)
     or pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, v_old_can_void, ''))
       <> pg_catalog.length(v_old_can_void) then
    raise exception 'Payroll V2 shortfall function differs from PR #66; no function was changed.';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_function_oid);
  v_definition := pg_catalog.replace(v_definition, v_old_void_declaration, v_new_void_declaration);
  v_definition := pg_catalog.replace(v_definition, v_old_prior_boundary, v_new_prior_boundary);
  v_definition := pg_catalog.replace(v_definition, v_old_can_void, v_new_can_void);
  execute v_definition;
end;
$migration$;

create unique index if not exists payroll_v2_prior_shortfall_void_once_idx
  on public.payroll_audit_logs (
    entity_id,
    (metadata ->> 'current_period_id'),
    (metadata ->> 'employee_user_id')
  )
  where action = 'payroll_v2_prior_committed_hours_shortfall_voided'
    and entity_type = 'payroll_v2_committed_hours_shortfall';

create or replace function public.payroll_v2_void_prior_committed_hours_shortfall(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid,
  p_prior_period_id uuid,
  p_reason text
) returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_actor uuid;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_shortfall jsonb;
  v_source_row jsonb;
  v_audit_id uuid;
begin
  v_actor := public.workforce_current_profile_id();
  if auth.uid() is null
     or v_actor is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
     ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to void a Payroll V2 prior-cutoff shortfall.';
  end if;

  if p_payroll_v2_period_id is null
     or p_employee_user_id is null
     or p_prior_period_id is null then
    raise exception using errcode = '22023', message = 'Current, prior, and employee IDs are required.';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) < 5 or pg_catalog.length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'A reason between 5 and 1000 characters is required.';
  end if;

  select period.*
  into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Payroll V2 period not found.';
  end if;
  if v_period.status <> 'draft' then
    raise exception using errcode = '55000', message = 'A prior-cutoff shortfall can only be voided in a Draft Payroll V2 period.';
  end if;

  if exists (
    select 1
    from public.payroll_v2_records record
    where record.payroll_v2_period_id = p_payroll_v2_period_id
      and record.employee_user_id = p_employee_user_id
      and record.status <> 'void'
      and not (
        record.status = 'calculated'
        and record.recalculation_pending_at is not null
        and record.approved_at is null
        and record.finalized_at is null
      )
  ) then
    raise exception using errcode = '55000',
      message = 'Reopen this unapproved calculation for recalculation before voiding its prior-cutoff shortfall.';
  end if;

  if exists (
    select 1
    from public.payroll_audit_logs audit
    where audit.action = 'payroll_v2_prior_committed_hours_shortfall_voided'
      and audit.entity_type = 'payroll_v2_committed_hours_shortfall'
      and audit.entity_id = p_prior_period_id
      and audit.metadata ->> 'current_period_id' = p_payroll_v2_period_id::text
      and audit.metadata ->> 'employee_user_id' = p_employee_user_id::text
  ) then
    raise exception using errcode = '23505', message = 'This employee shortfall was already voided for this period.';
  end if;

  v_shortfall := public.payroll_v2_prior_committed_hours_shortfall(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
  select source_row.value
  into v_source_row
  from pg_catalog.jsonb_array_elements(coalesce(v_shortfall -> 'rows', '[]'::jsonb)) source_row(value)
  where source_row.value ->> 'source_type' = 'payroll_v2_committed_hours_shortfall'
    and source_row.value ->> 'prior_period_id' = p_prior_period_id::text
  limit 1;
  if v_source_row is null then
    raise exception using errcode = '55000', message = 'No current qualifying shortfall exists for this employee and prior period.';
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason,
    metadata
  ) values (
    v_actor,
    'payroll_v2_prior_committed_hours_shortfall_voided',
    'payroll_v2_committed_hours_shortfall',
    p_prior_period_id,
    v_source_row,
    jsonb_build_object(
      'status', 'voided',
      'voided_at', statement_timestamp(),
      'current_period_id', p_payroll_v2_period_id,
      'employee_user_id', p_employee_user_id,
      'prior_period_id', p_prior_period_id
    ),
    v_reason,
    jsonb_build_object(
      'current_period_id', p_payroll_v2_period_id,
      'employee_user_id', p_employee_user_id,
      'prior_period_id', p_prior_period_id,
      'source_type', 'payroll_v2_committed_hours_shortfall',
      'source_snapshots', coalesce(v_source_row -> 'source_snapshots', '[]'::jsonb)
    )
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'voided', true,
    'audit_id', v_audit_id,
    'prior_period_id', p_prior_period_id,
    'current_period_id', p_payroll_v2_period_id,
    'employee_user_id', p_employee_user_id
  );
end;
$$;

comment on function public.payroll_v2_void_prior_committed_hours_shortfall(uuid, uuid, uuid, text) is
  'Voids one employee prior-cutoff Committed Hours shortfall through an audited marker, without changing payroll records or historical snapshots.';

revoke all on function public.payroll_v2_void_prior_committed_hours_shortfall(uuid, uuid, uuid, text) from public;
revoke execute on function public.payroll_v2_void_prior_committed_hours_shortfall(uuid, uuid, uuid, text) from anon;
grant execute on function public.payroll_v2_void_prior_committed_hours_shortfall(uuid, uuid, uuid, text) to authenticated, service_role;
