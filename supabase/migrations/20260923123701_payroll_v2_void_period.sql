-- Keep incorrect Payroll V2 Draft parents in history while blocking future use.
alter table public.payroll_v2_periods
  add column voided_at timestamptz,
  add column voided_by uuid references public.profiles(user_id) on delete restrict;
create or replace function public.payroll_v2_void_period(
  p_payroll_v2_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_v2_periods%rowtype;
  v_child_table record;
  v_period_column text;
  v_has_children boolean;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to void Payroll Dashboard V2 periods.';
  end if;

  if p_payroll_v2_period_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period is required.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id
  for update;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  if v_period.status <> 'draft' then
    raise exception using errcode = '55000',
      message = 'Only a Draft Payroll V2 period can be voided.';
  end if;

  -- Payroll V2 calculation children are not available in the current schema.
  -- Inspect future payroll_v2_* child tables when they are introduced, and
  -- fail closed if they reference this period directly or through a V2 record.
  for v_child_table in
    select table_info.table_name
    from information_schema.tables table_info
    where table_info.table_schema = 'public'
      and table_info.table_type = 'BASE TABLE'
      and table_info.table_name like 'payroll_v2_%'
  loop
    select column_info.column_name into v_period_column
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = v_child_table.table_name
      and column_info.column_name in (
        'payroll_v2_period_id', 'period_id', 'payroll_period_id'
      )
    order by case column_info.column_name
      when 'payroll_v2_period_id' then 1
      when 'period_id' then 2
      else 3
    end
    limit 1;

    if v_period_column is not null then
      execute pg_catalog.format(
        'select exists (select 1 from public.%I child where child.%I = $1)',
        v_child_table.table_name,
        v_period_column
      ) into v_has_children using p_payroll_v2_period_id;

      if v_has_children then
        raise exception using errcode = '55000',
          message = 'This Draft period already has persisted Payroll V2 calculation records, items, or snapshots and cannot be voided.';
      end if;
    elsif v_child_table.table_name <> 'payroll_v2_records'
      and exists (
        select 1 from information_schema.columns column_info
        where column_info.table_schema = 'public'
          and column_info.table_name = v_child_table.table_name
          and column_info.column_name = 'payroll_v2_record_id'
      )
      and exists (
        select 1 from information_schema.tables table_info
        where table_info.table_schema = 'public'
          and table_info.table_name = 'payroll_v2_records'
          and table_info.table_type = 'BASE TABLE'
      ) then
      select column_info.column_name into v_period_column
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'payroll_v2_records'
        and column_info.column_name in (
          'payroll_v2_period_id', 'period_id', 'payroll_period_id'
        )
      order by case column_info.column_name
        when 'payroll_v2_period_id' then 1
        when 'period_id' then 2
        else 3
      end
      limit 1;

      if v_period_column is not null then
        execute pg_catalog.format(
          'select exists (select 1 from public.%I child join public.payroll_v2_records record on record.id = child.payroll_v2_record_id where record.%I = $1)',
          v_child_table.table_name,
          v_period_column
        ) into v_has_children using p_payroll_v2_period_id;

        if v_has_children then
          raise exception using errcode = '55000',
            message = 'This Draft period already has persisted Payroll V2 calculation records, items, or snapshots and cannot be voided.';
        end if;
      end if;
    end if;

    v_period_column := null;
  end loop;

  update public.payroll_v2_periods period
  set status = 'void',
      voided_at = pg_catalog.statement_timestamp(),
      voided_by = v_actor_user_id
  where period.id = p_payroll_v2_period_id
    and period.status = 'draft'
  returning period.* into v_period;

  if not found then
    raise exception using errcode = '55000',
      message = 'Payroll V2 period is no longer Draft and was not changed.';
  end if;

  return pg_catalog.jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
    'status', v_period.status,
    'created_at', v_period.created_at,
    'voided_at', v_period.voided_at,
    'voided_by', v_period.voided_by
  );
end;
$function$;
revoke all on function public.payroll_v2_void_period(uuid)
  from public, anon;
grant execute on function public.payroll_v2_void_period(uuid)
  to authenticated, service_role;
comment on function public.payroll_v2_void_period(uuid) is
  'Voids only a Payroll V2 Draft period with no persisted V2 calculation records, items, or snapshots. Preserves the period parent and records the actor and timestamp.';
