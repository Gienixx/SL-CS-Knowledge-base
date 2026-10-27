begin;

-- Keep the public full-period payroll RPC unambiguous for PostgREST. The
-- scoped implementation is copied from the live function so its authorization,
-- snapshot, allocation, calculation, and audit behavior remain unchanged.
do $$
declare
  v_definition text;
  v_updated text;
  v_owner text;
  v_bad_rate_predicate text :=
    'effective_rate.effective_date <= coalesce(prepaid.effective_work_date, snapshot.work_date)';
  v_attendance_rate_predicate text :=
    'effective_rate.effective_date <= snapshot.work_date';
  v_first_bad_position integer;
  v_payable_start integer;
  v_lines_start integer;
begin
  v_definition := replace(
    pg_get_functiondef(
      'public.payroll_calculate_draft(uuid,uuid)'::regprocedure
    ),
    chr(13),
    ''
  );

  select pg_get_userbyid(proowner)
    into v_owner
  from pg_proc
  where oid = 'public.payroll_calculate_draft(uuid,uuid)'::regprocedure;

  if v_definition is null then
    raise exception 'The scoped payroll calculator was not found.';
  end if;

  v_updated := replace(
    v_definition,
    'public.payroll_calculate_draft(',
    'public.payroll_calculate_draft_for_record('
  );
  v_updated := replace(
    v_updated,
    ' DEFAULT NULL::uuid',
    ''
  );

  -- The attendance-payable rate is based on the attendance snapshot date.
  -- The prepaid earning insert later in the function intentionally uses the
  -- prepaid effective_work_date and must not be changed by this replacement.
  v_first_bad_position := strpos(v_updated, v_bad_rate_predicate);
  if v_first_bad_position = 0 then
    raise exception
      'The expected invalid prepaid rate predicate was not found.';
  end if;

  v_updated := overlay(
    v_updated placing v_attendance_rate_predicate
    from v_first_bad_position
    for length(v_bad_rate_predicate)
  );

  v_payable_start := strpos(v_updated, E'\n  payable as materialized (');
  v_lines_start := strpos(v_updated, E'\n  lines as (');
  if v_payable_start = 0
     or v_lines_start = 0
     or v_lines_start <= v_payable_start
     or strpos(
          substr(v_updated, v_payable_start, v_lines_start - v_payable_start),
          'prepaid.effective_work_date'
        ) > 0
     or strpos(
          substr(v_updated, v_payable_start, v_lines_start - v_payable_start),
          v_attendance_rate_predicate
        ) = 0
     or strpos(v_updated, v_bad_rate_predicate) = 0 then
    raise exception
      'The payroll rate-date rewrite did not preserve the intended source semantics.';
  end if;

  if v_owner is null
     or position('public.payroll_calculate_draft_for_record(' in v_updated) = 0
     or position('security definer' in lower(v_updated)) = 0
     or position('p_payroll_record_id uuid DEFAULT' in v_updated) > 0 then
    raise exception
      'Could not create the required-argument record payroll calculator.';
  end if;

  execute v_updated;
  execute format(
    'alter function public.payroll_calculate_draft_for_record(uuid,uuid) owner to %I',
    v_owner
  );
end;
$$;

create or replace function public.payroll_calculate_draft(
  p_payroll_period_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.payroll_calculate_draft_for_record(
    p_payroll_period_id,
    null::uuid
  );
$$;

create or replace function public.payroll_calculate_employee_draft(
  p_payroll_record_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
begin
  select record.payroll_period_id
    into v_period_id
  from public.payroll_records as record
  where record.id = p_payroll_record_id;

  if v_period_id is null then
    raise exception 'Payroll record not found.';
  end if;

  return public.payroll_calculate_draft_for_record(
    v_period_id,
    p_payroll_record_id
  );
end;
$$;

drop function public.payroll_calculate_draft(uuid, uuid);

revoke all on function public.payroll_calculate_draft(uuid)
  from public, anon;
revoke all on function public.payroll_calculate_draft_for_record(uuid, uuid)
  from public, anon;
revoke all on function public.payroll_calculate_employee_draft(uuid)
  from public, anon;

grant execute on function public.payroll_calculate_draft(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_calculate_draft_for_record(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.payroll_calculate_employee_draft(uuid)
  to authenticated, service_role;

comment on function public.payroll_calculate_draft(uuid) is
  'Atomically recalculates editable USD payroll from current approved snapshots, effective-dated rates, exact minutes, and active prepaid allocations. Requires create_payroll.';

comment on function public.payroll_calculate_draft_for_record(uuid, uuid) is
  'Atomically recalculates editable USD payroll for one payroll record, preserving the canonical full-period calculation rules and audit behavior.';

commit;

;
