-- Controlled Payroll V2 employee recalculation. The active record remains
-- calculated while explicitly opened; a required preview token protects the
-- authoritative replacement from stale browser state.

alter table public.payroll_v2_records
  add column recalculation_pending_at timestamptz,
  add column recalculation_pending_by uuid references public.profiles(user_id) on delete restrict,
  add column recalculation_pending_reason text;

alter table public.payroll_v2_records
  add constraint payroll_v2_records_recalculation_metadata_check
  check (
    (recalculation_pending_at is null and recalculation_pending_by is null and recalculation_pending_reason is null)
    or
    (recalculation_pending_at is not null and recalculation_pending_by is not null
      and recalculation_pending_reason is not null and length(btrim(recalculation_pending_reason)) between 5 and 240)
  );

-- The existing preview engine remains the sole formula. This token is a hash
-- of its exact payload and is checked again against the calculation writer.
create or replace function public.payroll_v2_preview_employee(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
) returns jsonb
language sql stable security definer set search_path = ''
as $function$
  with calculation as (
    select public.payroll_v2_employee_calculation_payload(
      p_payroll_v2_period_id, p_employee_user_id
    ) as payload
  )
  select calculation.payload || jsonb_build_object(
    'preview_token', md5((calculation.payload - 'employee')::text)
  )
  from calculation;
$function$;
revoke all on function public.payroll_v2_preview_employee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.payroll_v2_preview_employee(uuid, uuid) to authenticated, service_role;

create or replace function public.payroll_v2_reopen_employee_for_recalculation(
  p_payroll_v2_record_id uuid,
  p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_period_id uuid;
  v_period_status text;
  v_record public.payroll_v2_records%rowtype;
  v_actor uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_at timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.workforce_current_user_is_active()
     or not (public.workforce_has_permission('create_payroll') or public.workforce_has_permission('review_payroll')) then
    raise exception using errcode = '42501', message = 'You do not have permission to reopen a Payroll V2 calculation.';
  end if;
  v_actor := public.workforce_current_profile_id();
  if v_actor is null then
    raise exception using errcode = '42501', message = 'The authenticated payroll user could not be resolved.';
  end if;
  if p_payroll_v2_record_id is null or v_reason is null or length(v_reason) < 5 or length(v_reason) > 240 then
    raise exception using errcode = '22023', message = 'Enter a recalculation reason between 5 and 240 characters.';
  end if;
  select record.payroll_v2_period_id into v_period_id
  from public.payroll_v2_records record where record.id = p_payroll_v2_record_id;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 employee record was not found.'; end if;
  select period.status into v_period_status
  from public.payroll_v2_periods period where period.id = v_period_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 period was not found.'; end if;
  select record.* into v_record
  from public.payroll_v2_records record where record.id = p_payroll_v2_record_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 employee record was not found.'; end if;
  if v_period_status <> 'draft' then
    raise exception using errcode = '55000', message = 'Only a Draft Payroll V2 period can be reopened for recalculation.';
  end if;
  if v_record.status <> 'calculated' or v_record.approved_at is not null or v_record.finalized_at is not null then
    raise exception using errcode = '55000', message = 'Only an unapproved Calculated Payroll V2 record can be reopened.';
  end if;
  if v_record.recalculation_pending_at is not null then
    raise exception using errcode = '55000', message = 'This payroll calculation is already open for recalculation.';
  end if;
  update public.payroll_v2_records record
  set recalculation_pending_at = v_at,
      recalculation_pending_by = v_actor,
      recalculation_pending_reason = v_reason,
      updated_at = v_at
  where record.id = v_record.id;
  insert into public.payroll_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (v_actor, 'payroll_v2_recalculation_reopened', 'payroll_v2_record', v_record.id,
    jsonb_build_object('status', v_record.status, 'calculated_at', v_record.calculated_at),
    jsonb_build_object('status', v_record.status, 'recalculation_pending_at', v_at),
    jsonb_build_object('payroll_v2_period_id', v_record.payroll_v2_period_id,
      'employee_user_id', v_record.employee_user_id, 'reason', v_reason));
  return jsonb_build_object('payroll_v2_record_id', v_record.id, 'record_status', v_record.status,
    'recalculation_pending', true, 'recalculation_pending_at', v_at, 'reason', v_reason);
end;
$function$;
revoke all on function public.payroll_v2_reopen_employee_for_recalculation(uuid, text) from public, anon, authenticated;
grant execute on function public.payroll_v2_reopen_employee_for_recalculation(uuid, text) to authenticated, service_role;

-- Permit adjustment source mutations only for an explicitly reopened,
-- calculated record. Preserve each existing RPC's validation and audit body.
do $patch$
declare
  v_definition text;
  v_old text := $anchor$if exists(select 1 from public.payroll_v2_records r where r.payroll_v2_period_id = p_payroll_v2_period_id
      and r.employee_user_id = p_employee_user_id and r.status <> 'void') then
    raise exception using errcode = '55000', message = 'Adjustments are locked after this employee has been calculated.';
  end if;$anchor$;
  v_new text := $replacement$if exists(select 1 from public.payroll_v2_records r where r.payroll_v2_period_id = p_payroll_v2_period_id
      and r.employee_user_id = p_employee_user_id and r.status <> 'void'
      and not (r.status = 'calculated' and r.recalculation_pending_at is not null
        and r.approved_at is null and r.finalized_at is null)) then
    raise exception using errcode = '55000', message = 'Adjustments are locked unless this Calculated employee is reopened for recalculation.';
  end if;$replacement$;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_add_employee_adjustment(uuid,uuid,text,text,numeric)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Payroll V2 add-adjustment guard changed; patch aborted.'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
  select pg_catalog.pg_get_functiondef('public.payroll_v2_void_employee_adjustment(uuid,uuid,uuid,text)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Payroll V2 void-adjustment guard changed; patch aborted.'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;

-- Approval is held while an explicitly reopened calculation is being corrected.
do $patch$
declare v_definition text;
  v_old text := $anchor$  if v_record.status <> 'calculated' then
    raise exception using errcode = '55000',
      message = 'Only a calculated Payroll V2 employee record can be approved.';
  end if;$anchor$;
  v_new text := $replacement$  if v_record.status <> 'calculated' then
    raise exception using errcode = '55000',
      message = 'Only a calculated Payroll V2 employee record can be approved.';
  end if;
  if v_record.recalculation_pending_at is not null then
    raise exception using errcode = '55000',
      message = 'Complete or cancel the open recalculation before approving this employee.';
  end if;$replacement$;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_approve_employee(uuid)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Payroll V2 approval guard changed; patch aborted.'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;

-- Surface the explicit edit window to the detached V2 read model.
do $patch$
declare v_definition text;
  v_old text := $anchor$      'calculated_at', v_record.calculated_at,
      'approved_at', v_record.approved_at,$anchor$;
  v_new text := $replacement$      'calculated_at', v_record.calculated_at,
      'recalculation_pending', v_record.recalculation_pending_at is not null,
      'recalculation_pending_at', v_record.recalculation_pending_at,
      'recalculation_pending_by', v_record.recalculation_pending_by,
      'recalculation_pending_reason', v_record.recalculation_pending_reason,
      'approved_at', v_record.approved_at,$replacement$;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_get_calculated_employee(uuid,uuid)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Payroll V2 saved-result read model changed; metadata patch aborted.'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;

create or replace function public.payroll_v2_recalculate_employee(
  p_payroll_v2_record_id uuid,
  p_preview_token text,
  p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_period_id uuid;
  v_period public.payroll_v2_periods%rowtype;
  v_record public.payroll_v2_records%rowtype;
  v_temporary_record public.payroll_v2_records%rowtype;
  v_actor uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_at timestamptz := statement_timestamp();
  v_payload jsonb;
  v_calculated jsonb;
  v_new_snapshot jsonb;
  v_result jsonb;
  v_before_data jsonb;
  v_after_data jsonb;
  v_before_item_count bigint;
  v_before_attendance_count bigint;
  v_before_commitment_count bigint;
  v_after_item_count bigint;
  v_after_attendance_count bigint;
  v_after_commitment_count bigint;
begin
  if auth.uid() is null or not public.workforce_current_user_is_active()
     or not (public.workforce_has_permission('create_payroll') or public.workforce_has_permission('review_payroll')) then
    raise exception using errcode = '42501', message = 'You do not have permission to recalculate Payroll V2 employee pay.';
  end if;
  v_actor := public.workforce_current_profile_id();
  if v_actor is null then raise exception using errcode = '42501', message = 'The authenticated payroll user could not be resolved.'; end if;
  if p_payroll_v2_record_id is null or p_preview_token is null or p_preview_token !~ '^[0-9a-f]{32}$'
     or v_reason is null or length(v_reason) < 5 or length(v_reason) > 240 then
    raise exception using errcode = '22023', message = 'Run a fresh Preview Payroll and enter a reason between 5 and 240 characters.';
  end if;
  select record.payroll_v2_period_id into v_period_id
  from public.payroll_v2_records record where record.id = p_payroll_v2_record_id;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 employee record was not found.'; end if;
  select period.* into v_period from public.payroll_v2_periods period where period.id = v_period_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 period was not found.'; end if;
  select record.* into v_record from public.payroll_v2_records record where record.id = p_payroll_v2_record_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 employee record was not found.'; end if;
  if v_period.status <> 'draft' then raise exception using errcode = '55000', message = 'Only a Draft Payroll V2 period can be recalculated.'; end if;
  if v_record.status <> 'calculated' or v_record.approved_at is not null or v_record.finalized_at is not null then
    raise exception using errcode = '55000', message = 'Only an unapproved Calculated Payroll V2 record can be recalculated.';
  end if;
  if v_record.recalculation_pending_at is null then
    raise exception using errcode = '55000', message = 'Reopen this Calculated employee for recalculation before continuing.';
  end if;

  -- The preview token must match current server inputs. The employee object is
  -- excluded because its status is lifecycle display metadata, not a formula input.
  v_payload := public.payroll_v2_employee_calculation_payload(v_period.id, v_record.employee_user_id);
  if coalesce((v_payload ->> 'ready_to_preview')::boolean, false) is not true
     or md5((v_payload - 'employee')::text) <> p_preview_token then
    raise exception using errcode = '55000', message = 'Payroll inputs changed or readiness is blocked. Run Preview Payroll again before recalculating.';
  end if;

  select count(*) into v_before_item_count from public.payroll_v2_items where payroll_v2_record_id = v_record.id;
  select count(*) into v_before_attendance_count from public.payroll_v2_attendance_snapshots where payroll_v2_record_id = v_record.id;
  select count(*) into v_before_commitment_count from public.payroll_v2_committed_hours_snapshots where payroll_v2_record_id = v_record.id;
  v_before_data := jsonb_build_object(
    'status', v_record.status, 'calculated_at', v_record.calculated_at,
    'gross_pay', v_record.calculation_snapshot -> 'gross_pay',
    'total_deductions', v_record.calculation_snapshot -> 'total_deductions',
    'net_pay', v_record.calculation_snapshot -> 'net_pay',
    'item_count', v_before_item_count,
    'attendance_snapshot_count', v_before_attendance_count,
    'committed_hours_snapshot_count', v_before_commitment_count
  );

  -- Use the Calculate Employee RPC as the persistence engine inside this same
  -- transaction, then transfer its freshly built children back onto the same
  -- authoritative record ID. Any failure rolls the whole change back.
  update public.payroll_v2_records set status = 'void', updated_at = v_at where id = v_record.id;
  v_calculated := public.payroll_v2_calculate_employee(v_period.id, v_record.employee_user_id);
  if coalesce((v_calculated -> 'persistence' ->> 'saved')::boolean, false) is not true then
    raise exception using errcode = '55000', message = 'The shared Payroll V2 calculation engine did not persist a replacement result.';
  end if;
  select record.* into v_temporary_record
  from public.payroll_v2_records record
  where record.id = (v_calculated -> 'persistence' ->> 'payroll_v2_record_id')::uuid
  for update;
  if not found or v_temporary_record.id = v_record.id then
    raise exception using errcode = '55000', message = 'The temporary recalculation record could not be verified.';
  end if;
  if md5((v_temporary_record.calculation_snapshot - 'attendance_source_rows' - 'calculation_version' - 'employee')::text) <> p_preview_token then
    raise exception using errcode = '55000', message = 'Payroll inputs changed during recalculation. No changes were saved; preview again.';
  end if;
  v_new_snapshot := v_temporary_record.calculation_snapshot || jsonb_build_object(
    'employee', jsonb_set(coalesce(v_temporary_record.calculation_snapshot -> 'employee', '{}'::jsonb), '{payslip_status}', '"Calculated"'::jsonb, true)
  );

  delete from public.payroll_v2_items where payroll_v2_record_id = v_record.id;
  delete from public.payroll_v2_attendance_snapshots where payroll_v2_record_id = v_record.id;
  delete from public.payroll_v2_committed_hours_snapshots where payroll_v2_record_id = v_record.id;
  update public.payroll_v2_items set payroll_v2_record_id = v_record.id where payroll_v2_record_id = v_temporary_record.id;
  update public.payroll_v2_attendance_snapshots set payroll_v2_record_id = v_record.id where payroll_v2_record_id = v_temporary_record.id;
  update public.payroll_v2_committed_hours_snapshots set payroll_v2_record_id = v_record.id where payroll_v2_record_id = v_temporary_record.id;
  delete from public.payroll_v2_records where id = v_temporary_record.id;

  update public.payroll_v2_records record
  set status = 'calculated',
      calculated_at = v_temporary_record.calculated_at,
      calculation_snapshot = v_new_snapshot,
      approved_by = null,
      approved_at = null,
      finalized_at = null,
      recalculation_pending_at = null,
      recalculation_pending_by = null,
      recalculation_pending_reason = null,
      updated_at = v_at
  where record.id = v_record.id;

  select count(*) into v_after_item_count from public.payroll_v2_items where payroll_v2_record_id = v_record.id;
  select count(*) into v_after_attendance_count from public.payroll_v2_attendance_snapshots where payroll_v2_record_id = v_record.id;
  select count(*) into v_after_commitment_count from public.payroll_v2_committed_hours_snapshots where payroll_v2_record_id = v_record.id;
  v_after_data := jsonb_build_object(
    'status', 'calculated', 'calculated_at', v_temporary_record.calculated_at,
    'gross_pay', v_new_snapshot -> 'gross_pay',
    'total_deductions', v_new_snapshot -> 'total_deductions',
    'net_pay', v_new_snapshot -> 'net_pay',
    'item_count', v_after_item_count,
    'attendance_snapshot_count', v_after_attendance_count,
    'committed_hours_snapshot_count', v_after_commitment_count
  );
  insert into public.payroll_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (v_actor, 'payroll_v2_employee_recalculated', 'payroll_v2_record', v_record.id,
    v_before_data, v_after_data,
    jsonb_build_object('payroll_v2_period_id', v_period.id,
      'employee_user_id', v_record.employee_user_id, 'reason', v_reason,
      'recalculation_pending_at', v_record.recalculation_pending_at,
      'recalculation_pending_by', v_record.recalculation_pending_by));

  v_result := v_calculated || jsonb_build_object(
    'employee', v_new_snapshot -> 'employee',
    'persistence', jsonb_build_object(
      'saved', true, 'payroll_v2_record_id', v_record.id,
      'record_status', 'calculated', 'calculated_at', v_temporary_record.calculated_at,
      'approved_at', null, 'recalculated', true,
      'message', 'Recalculated successfully. The saved Payroll V2 result has been refreshed.'
    )
  );
  return v_result;
end;
$function$;
revoke all on function public.payroll_v2_recalculate_employee(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payroll_v2_recalculate_employee(uuid, text, text) to authenticated, service_role;

;
