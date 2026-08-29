begin;

-- PostgREST cannot disambiguate the public one-argument RPC from the
-- two-argument implementation when the latter's record argument defaults to
-- NULL. Keep the public full-period RPC unambiguous and give the scoped
-- implementation its own name. The implementation body is deliberately
-- copied from the live function so snapshot, authorization, idempotency, and
-- reconciliation behavior do not change.
do $$
declare
  v_definition text;
  v_updated text;
  v_owner text;
begin
  v_definition := pg_get_functiondef(
    'public.payroll_import_attendance(uuid,uuid)'::regprocedure
  );
  select pg_get_userbyid(proowner)
    into v_owner
  from pg_proc
  where oid = 'public.payroll_import_attendance(uuid,uuid)'::regprocedure;

  v_updated := replace(
    v_definition,
    'public.payroll_import_attendance(',
    'public.payroll_import_attendance_for_record('
  );
  v_updated := replace(
    v_updated,
    ' DEFAULT NULL::uuid',
    ''
  );

  if v_updated = v_definition
     or position('public.payroll_import_attendance_for_record(' in v_updated) = 0
     or position('p_payroll_record_id uuid DEFAULT' in v_updated) > 0 then
    raise exception
      'Could not create the required-argument record attendance import function';
  end if;

  execute v_updated;
  execute format(
    'alter function public.payroll_import_attendance_for_record(uuid,uuid) owner to %I',
    v_owner
  );
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

drop function public.payroll_import_attendance(uuid, uuid);

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
