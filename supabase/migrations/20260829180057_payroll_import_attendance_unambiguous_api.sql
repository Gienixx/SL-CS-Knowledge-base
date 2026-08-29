begin;

-- PostgREST cannot disambiguate the public one-argument RPC from the
-- two-argument implementation when the latter's record argument defaults to
-- NULL. Keep the public full-period RPC unambiguous and give the scoped
-- implementation its own name. The implementation body is deliberately
-- preserved so snapshot, authorization, idempotency, and reconciliation
-- behavior do not change.
alter function public.payroll_import_attendance(uuid, uuid)
  rename to payroll_import_attendance_for_record;

-- The old implementation used a nullable default for its record scope. Drop
-- that default on the renamed function so the record-specific API requires
-- both identifiers while retaining the exact live implementation body.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.payroll_import_attendance_for_record(uuid,uuid)'::regprocedure
  );
  v_updated := replace(
    v_definition,
    ' DEFAULT NULL::uuid',
    ''
  );

  if v_updated = v_definition
     or position('p_payroll_record_id uuid DEFAULT' in v_updated) > 0 then
    raise exception
      'payroll_import_attendance_for_record retained its nullable record default';
  end if;

  execute v_updated;
end;
$$;

create or replace function public.payroll_import_attendance(
  p_payroll_period_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.payroll_import_attendance_for_record(p_payroll_period_id, null::uuid);
$$;

create or replace function public.payroll_import_employee_attendance(
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

  return public.payroll_import_attendance_for_record(v_period_id, p_payroll_record_id);
end;
$$;

revoke all on function public.payroll_import_attendance(uuid)
  from public, anon;
revoke all on function public.payroll_import_attendance_for_record(uuid, uuid)
  from public, anon;
revoke all on function public.payroll_import_employee_attendance(uuid)
  from public, anon;

grant execute on function public.payroll_import_attendance(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_import_attendance_for_record(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.payroll_import_employee_attendance(uuid)
  to authenticated, service_role;

comment on function public.payroll_import_attendance(uuid) is
  'Imports all payroll-ready attendance for a draft or reopened payroll period.';

comment on function public.payroll_import_attendance_for_record(uuid, uuid) is
  'Imports payroll-ready attendance for one payroll record using the canonical snapshot and reconciliation rules.';

commit;
