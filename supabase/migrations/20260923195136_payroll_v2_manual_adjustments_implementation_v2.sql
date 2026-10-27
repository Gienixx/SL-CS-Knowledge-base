-- Payroll V2 employee-scoped manual earnings and deductions.
-- All adjustment mutations are RPC-only, period/employee scoped, and blocked
-- as soon as an employee calculation exists.

alter table public.payroll_v2_manual_earnings
  add column if not exists approved_at timestamptz,
  add column if not exists voided_by uuid references public.profiles(user_id) on delete restrict,
  add column if not exists voided_at timestamptz;

create table public.payroll_v2_deductions (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_period_id uuid not null references public.payroll_v2_periods(id) on delete restrict,
  employee_user_id uuid not null references public.profiles(user_id) on delete restrict,
  description text not null,
  amount numeric(12,2) not null,
  status text not null default 'approved',
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  approved_by uuid not null references public.profiles(user_id) on delete restrict,
  approved_at timestamptz not null default statement_timestamp(),
  voided_by uuid references public.profiles(user_id) on delete restrict,
  voided_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_deductions_status_check check (status in ('approved', 'void')),
  constraint payroll_v2_deductions_positive_amount_check check (amount > 0),
  constraint payroll_v2_deductions_description_check check (length(btrim(description)) > 0),
  constraint payroll_v2_deductions_void_metadata_check
    check ((status = 'void') = (voided_at is not null and voided_by is not null))
);

create index payroll_v2_deductions_period_employee_idx
  on public.payroll_v2_deductions(payroll_v2_period_id, employee_user_id, status, created_at);
alter table public.payroll_v2_deductions enable row level security;
revoke all on table public.payroll_v2_deductions from public, anon, authenticated;
grant all on table public.payroll_v2_deductions to service_role;
comment on table public.payroll_v2_deductions is
  'Payroll V2-only approved deductions. Mutated only through guarded RPCs; never shared with V1 payroll_items.';

create or replace function public.payroll_v2_list_employee_adjustments(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_manual jsonb;
  v_deductions jsonb;
begin
  if auth.uid() is null or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception using errcode = '42501', message = 'You do not have permission to view Payroll V2 adjustments.';
  end if;
  if p_payroll_v2_period_id is null or p_employee_user_id is null then
    raise exception using errcode = '22023', message = 'A Payroll V2 period and employee are required.';
  end if;
  if not exists(select 1 from public.payroll_v2_periods p where p.id = p_payroll_v2_period_id) then
    raise exception using errcode = 'P0002', message = 'Payroll V2 period not found.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'description', e.description, 'amount', e.amount,
    'status', initcap(replace(e.status, '_', ' ')), 'kind', 'earning',
    'can_void', e.status = 'approved'
  ) order by e.created_at, e.id), '[]'::jsonb)
  into v_manual
  from public.payroll_v2_manual_earnings e
  where e.payroll_v2_period_id = p_payroll_v2_period_id
    and e.employee_user_id = p_employee_user_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'description', d.description, 'amount', d.amount,
    'status', initcap(d.status), 'kind', 'deduction', 'can_void', d.status = 'approved'
  ) order by d.created_at, d.id), '[]'::jsonb)
  into v_deductions
  from public.payroll_v2_deductions d
  where d.payroll_v2_period_id = p_payroll_v2_period_id
    and d.employee_user_id = p_employee_user_id;
  return jsonb_build_object('manual_earnings', v_manual, 'deductions', v_deductions);
end;
$function$;
revoke all on function public.payroll_v2_list_employee_adjustments(uuid,uuid) from public, anon, authenticated;
grant execute on function public.payroll_v2_list_employee_adjustments(uuid,uuid) to authenticated, service_role;

create or replace function public.payroll_v2_add_employee_adjustment(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid,
  p_kind text,
  p_description text,
  p_amount numeric
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_actor uuid;
  v_id uuid;
  v_table text;
begin
  v_actor := public.workforce_current_profile_id();
  if auth.uid() is null or v_actor is null or not public.workforce_current_user_is_active()
     or not (public.workforce_has_permission('create_payroll') or public.workforce_has_permission('review_payroll')) then
    raise exception using errcode = '42501', message = 'You do not have permission to add Payroll V2 adjustments.';
  end if;
  if p_kind not in ('earning', 'deduction') or p_payroll_v2_period_id is null or p_employee_user_id is null then
    raise exception using errcode = '22023', message = 'A valid adjustment kind, Payroll V2 period, and employee are required.';
  end if;
  if nullif(btrim(p_description), '') is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Enter a description and a positive amount.';
  end if;
  select p.* into v_period from public.payroll_v2_periods p where p.id = p_payroll_v2_period_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 period not found.'; end if;
  if v_period.status <> 'draft' then raise exception using errcode = '55000', message = 'Adjustments can only be added to a Draft Payroll V2 period.'; end if;
  if not exists(select 1 from public.profiles p where p.user_id = p_employee_user_id) then
    raise exception using errcode = 'P0002', message = 'Employee not found.';
  end if;
  if exists(select 1 from public.payroll_v2_records r where r.payroll_v2_period_id = p_payroll_v2_period_id
      and r.employee_user_id = p_employee_user_id and r.status <> 'void') then
    raise exception using errcode = '55000', message = 'Adjustments are locked after this employee has been calculated.';
  end if;
  if p_kind = 'earning' then
    insert into public.payroll_v2_manual_earnings(
      payroll_v2_period_id, employee_user_id, description, amount, status,
      created_by, approved_by, approved_at, updated_at
    ) values (
      p_payroll_v2_period_id, p_employee_user_id, btrim(p_description), round(p_amount,2),
      'approved', v_actor, v_actor, statement_timestamp(), statement_timestamp()
    ) returning id into v_id;
    v_table := 'payroll_v2_manual_earnings';
  else
    insert into public.payroll_v2_deductions(
      payroll_v2_period_id, employee_user_id, description, amount,
      created_by, approved_by, approved_at, updated_at
    ) values (
      p_payroll_v2_period_id, p_employee_user_id, btrim(p_description), round(p_amount,2),
      v_actor, v_actor, statement_timestamp(), statement_timestamp()
    ) returning id into v_id;
    v_table := 'payroll_v2_deductions';
  end if;
  insert into public.payroll_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (v_actor, 'payroll_v2_' || p_kind || '_added', v_table, v_id, null,
    jsonb_build_object('description',btrim(p_description),'amount',round(p_amount,2),'status','approved'),
    jsonb_build_object('payroll_v2_period_id',p_payroll_v2_period_id,'employee_user_id',p_employee_user_id));
  return jsonb_build_object('id', v_id, 'kind', p_kind, 'status', 'approved');
end;
$function$;
revoke all on function public.payroll_v2_add_employee_adjustment(uuid,uuid,text,text,numeric) from public, anon, authenticated;
grant execute on function public.payroll_v2_add_employee_adjustment(uuid,uuid,text,text,numeric) to authenticated, service_role;

create or replace function public.payroll_v2_void_employee_adjustment(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid,
  p_adjustment_id uuid,
  p_kind text
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_actor uuid;
  v_before jsonb;
  v_table text;
begin
  v_actor := public.workforce_current_profile_id();
  if auth.uid() is null or v_actor is null or not public.workforce_current_user_is_active()
     or not (public.workforce_has_permission('create_payroll') or public.workforce_has_permission('review_payroll')) then
    raise exception using errcode = '42501', message = 'You do not have permission to void Payroll V2 adjustments.';
  end if;
  if p_kind not in ('earning', 'deduction') or p_adjustment_id is null then
    raise exception using errcode = '22023', message = 'A valid adjustment kind and ID are required.';
  end if;
  select p.* into v_period from public.payroll_v2_periods p where p.id = p_payroll_v2_period_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll V2 period not found.'; end if;
  if v_period.status <> 'draft' then raise exception using errcode = '55000', message = 'Adjustments can only be voided in a Draft Payroll V2 period.'; end if;
  if exists(select 1 from public.payroll_v2_records r where r.payroll_v2_period_id = p_payroll_v2_period_id
      and r.employee_user_id = p_employee_user_id and r.status <> 'void') then
    raise exception using errcode = '55000', message = 'Adjustments are locked after this employee has been calculated.';
  end if;
  if p_kind = 'earning' then
    select to_jsonb(e) into v_before from public.payroll_v2_manual_earnings e
    where e.id = p_adjustment_id and e.payroll_v2_period_id = p_payroll_v2_period_id
      and e.employee_user_id = p_employee_user_id and e.status = 'approved' for update;
    if v_before is null then raise exception using errcode = '55000', message = 'Approved adjustment not found in the selected employee and period.'; end if;
    update public.payroll_v2_manual_earnings set status='void', voided_by=v_actor,
      voided_at=statement_timestamp(), updated_at=statement_timestamp() where id=p_adjustment_id;
    v_table := 'payroll_v2_manual_earnings';
  else
    select to_jsonb(d) into v_before from public.payroll_v2_deductions d
    where d.id = p_adjustment_id and d.payroll_v2_period_id = p_payroll_v2_period_id
      and d.employee_user_id = p_employee_user_id and d.status = 'approved' for update;
    if v_before is null then raise exception using errcode = '55000', message = 'Approved adjustment not found in the selected employee and period.'; end if;
    update public.payroll_v2_deductions set status='void', voided_by=v_actor,
      voided_at=statement_timestamp(), updated_at=statement_timestamp() where id=p_adjustment_id;
    v_table := 'payroll_v2_deductions';
  end if;
  insert into public.payroll_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (v_actor, 'payroll_v2_' || p_kind || '_voided', v_table, p_adjustment_id, v_before,
    jsonb_build_object('status','void','voided_by',v_actor),
    jsonb_build_object('payroll_v2_period_id',p_payroll_v2_period_id,'employee_user_id',p_employee_user_id));
  return jsonb_build_object('id', p_adjustment_id, 'kind', p_kind, 'status', 'void');
end;
$function$;
revoke all on function public.payroll_v2_void_employee_adjustment(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.payroll_v2_void_employee_adjustment(uuid,uuid,uuid,text) to authenticated, service_role;

-- Extend the shared server calculation payload with exactly the approved V2
-- adjustments. Guard every textual patch so a changed live function fails closed.
do $patch$
declare v_definition text;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_employee_calculation_payload(uuid,uuid)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, 'v_manual jsonb := ''[]''::jsonb;') = 0
     or pg_catalog.strpos(v_definition, 'v_net_pay numeric(14,2);') = 0
     or pg_catalog.strpos(v_definition, '  -- A rate is selected independently for each work date.') = 0
     or pg_catalog.strpos(v_definition, '''gross_pay'', v_gross_pay,') = 0
     or pg_catalog.strpos(v_definition, '''total_deductions'', case when v_ready then 0::numeric else null::numeric end,') = 0 then
    raise exception 'Payroll V2 payload changed; adjustment patch anchors not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, 'v_manual jsonb := ''[]''::jsonb;',
    'v_manual jsonb := ''[]''::jsonb;' || E'\n  v_deduction_rows jsonb := ''[]''::jsonb;\n  v_deductions numeric(14,2) := 0;');
  v_definition := pg_catalog.replace(v_definition, 'v_net_pay numeric(14,2);',
    'v_net_pay numeric(14,2);' || E'\n  v_net_pay numeric(14,2);');
  -- Prevent duplicate declaration: the first declaration is retained as the
  -- replacement target above; use a safe rename then restore one declaration.
  v_definition := pg_catalog.replace(v_definition, E'  v_net_pay numeric(14,2);\n  v_net_pay numeric(14,2);',
    E'  v_net_pay numeric(14,2);');
  v_definition := pg_catalog.replace(v_definition,
    '  -- A rate is selected independently for each work date.',
    $insert$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'description', d.description, 'amount', d.amount,
    'currency_code', v_currency_code,
    'status', pg_catalog.initcap(d.status), 'kind', 'deduction',
    'included_in_preview', d.status = 'approved'
  ) order by d.created_at, d.id), '[]'::jsonb)
  into v_deduction_rows
  from public.payroll_v2_deductions d
  where d.payroll_v2_period_id = p_payroll_v2_period_id
    and d.employee_user_id = p_employee_user_id;
  select coalesce(sum(d.amount) filter (where d.status = 'approved'), 0)::numeric(14,2)
  into v_deductions
  from public.payroll_v2_deductions d
  where d.payroll_v2_period_id = p_payroll_v2_period_id
    and d.employee_user_id = p_employee_user_id;

  -- A rate is selected independently for each work date.$insert$);
  v_definition := pg_catalog.replace(v_definition,
    'v_attendance_earnings + v_leave_earnings + v_committed_earnings + v_manual_earnings, 2',
    'v_attendance_earnings + v_leave_earnings + v_committed_earnings + v_manual_earnings, 2');
  v_definition := pg_catalog.replace(v_definition, '    v_net_pay := v_gross_pay;', '    v_net_pay := v_gross_pay - v_deductions;');
  v_definition := pg_catalog.replace(v_definition,
    E'    ''gross_pay'', v_gross_pay,\n    ''total_deductions'', case when v_ready then 0::numeric else null::numeric end,\n    ''net_pay'', v_net_pay,\n    ''net_pay_basis'', ''No V2 deductions are configured; net equals gross in this preview.'',',
    E'    ''gross_pay'', v_gross_pay,\n    ''deductions'', jsonb_build_object(''rows'', v_deduction_rows, ''approved_amount'', case when v_ready then v_deductions else null end, ''approved_count'', (select count(*) from public.payroll_v2_deductions d where d.payroll_v2_period_id = p_payroll_v2_period_id and d.employee_user_id = p_employee_user_id and d.status = ''approved''), ''excluded_count'', (select count(*) from public.payroll_v2_deductions d where d.payroll_v2_period_id = p_payroll_v2_period_id and d.employee_user_id = p_employee_user_id and d.status <> ''approved'')),\n    ''total_deductions'', case when v_ready then v_deductions else null::numeric end,\n    ''net_pay'', v_net_pay,\n    ''net_pay_basis'', ''Gross pay less approved Payroll V2 deductions.'',');
  if pg_catalog.strpos(v_definition, 'v_deduction_rows') = 0
     or pg_catalog.strpos(v_definition, 'v_net_pay := v_gross_pay - v_deductions') = 0
     or pg_catalog.strpos(v_definition, '''deductions'', jsonb_build_object') = 0 then
    raise exception 'Payroll V2 adjustment formula patch failed verification.';
  end if;
  execute v_definition;
end;
$patch$;

-- Persist a positive, source-traceable V2 deduction item for each approved
-- deduction used by the shared calculation payload.
do $patch$
declare v_definition text;
begin
  select pg_catalog.pg_get_functiondef('public.payroll_v2_calculate_employee(uuid,uuid)'::regprocedure) into v_definition;
  if pg_catalog.strpos(v_definition, '  -- Snapshot one attendance aggregation per actual payroll-facing work date.') = 0
     or pg_catalog.strpos(v_definition, '''manual_earning''') = 0 then
    raise exception 'Payroll V2 calculate patch anchors not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition,
    '  -- Snapshot one attendance aggregation per actual payroll-facing work date.',
    $insert$
  for v_item in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'deductions' -> 'rows', '[]'::jsonb))
    where coalesce((value ->> 'included_in_preview')::boolean, false)
  loop
    insert into public.payroll_v2_items (
      payroll_v2_record_id, item_type, description, source_type, source_id, amount, metadata
    ) values (
      v_record_id, 'deduction', coalesce(nullif(v_item ->> 'description', ''), 'Deduction'),
      'payroll_v2_deductions', (v_item ->> 'id')::uuid,
      (v_item ->> 'amount')::numeric(12,2),
      jsonb_build_object('status',v_item -> 'status','currency_code',v_item -> 'currency_code')
    );
  end loop;

  -- Snapshot one attendance aggregation per actual payroll-facing work date.$insert$);
  if pg_catalog.strpos(v_definition, 'payroll_v2_deductions') = 0 then
    raise exception 'Payroll V2 deduction item patch failed verification.';
  end if;
  execute v_definition;
end;
$patch$;

;
