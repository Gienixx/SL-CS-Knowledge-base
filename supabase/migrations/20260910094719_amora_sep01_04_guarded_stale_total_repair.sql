-- Design/validation artifact only. Do not apply until the production precheck
-- proves the four-row manifest is unchanged.
-- Repairs only total_worked_minutes; it does not approve, import, calculate,
-- finalize payroll, or create snapshots/allocations.

begin;

create or replace function public.workforce_repair_amora_sep01_04_stale_totals(
  p_actor_user_id uuid,
  p_reason text
)
returns table (
  attendance_id uuid,
  previous_total integer,
  new_total integer,
  previous_version bigint,
  new_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_period_id uuid := '2030808c-8292-4cd2-b994-2b1afbed371e';
  v_actor_is_admin boolean;
begin
  if p_actor_user_id is null or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'System-admin actor and repair reason are required.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id
      and p.is_system_admin is true
      and p.account_deleted_at is null
  ) into v_actor_is_admin;
  if not v_actor_is_admin then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  for v_target in
    select * from (values
      ('d2ff495d-bae1-45da-862b-a9f0dd215df8'::uuid, date '2026-09-01', 732, '83452225-a86a-4d58-a955-1eb08aaa368f'::uuid, 9::bigint),
      ('713cafb9-f351-4fdc-ae32-061734996adf'::uuid, date '2026-09-02', 730, 'e41a3300-5533-4fd5-ade5-375f54df731d'::uuid, 9::bigint),
      ('145d09d4-2520-47bf-8dd4-1455fdcd8953'::uuid, date '2026-09-03', 730, '54d8737e-4e69-45cc-8861-17a2fa3b573b'::uuid, 9::bigint),
      ('810f1e60-699b-42a1-897a-db5c9e8377c4'::uuid, date '2026-09-04', 729, 'add582f7-b9ab-4fe3-8ce2-c27984abb69c'::uuid, 9::bigint)
    ) as t(attendance_id, work_date, old_total, schedule_id, expected_version)
  loop
    select a.* into v_before
    from public.attendance a
    where a.id = v_target.attendance_id
    for update;
    if not found then raise exception 'Target attendance % is missing.', v_target.attendance_id; end if;

    if v_before.work_date is distinct from v_target.work_date
       or v_before.attendance_version is distinct from v_target.expected_version
       or v_before.total_worked_minutes is distinct from v_target.old_total
       or v_before.review_status is distinct from 'corrected'
       or v_before.payroll_approved_at is not null
       or v_before.schedule_id is distinct from v_target.schedule_id
       or v_before.billed_clock_in is distinct from (timestamptz (v_target.work_date::text || ' 23:00:00+00'))
       or v_before.billed_clock_out is distinct from (timestamptz ((v_target.work_date + 1)::text || ' 11:00:00+00'))
       or v_before.regular_minutes is distinct from 480
       or v_before.pre_shift_overtime_minutes is distinct from 120
       or v_before.post_shift_overtime_minutes is distinct from 120
       or v_before.total_overtime_minutes is distinct from 240
       or public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out) is distinct from 720 then
      raise exception 'Target % no longer matches the exact stale-total manifest.', v_target.attendance_id;
    end if;

    if exists (select 1 from public.payroll_attendance_snapshots s where s.attendance_id = v_before.id)
       or exists (select 1 from public.payroll_items i join public.payroll_attendance_snapshots s on s.id=i.source_attendance_snapshot_id where s.attendance_id=v_before.id)
       or exists (select 1 from public.payroll_records r join public.payslips p on p.payroll_record_id=r.id where r.payroll_period_id=v_period_id and r.employee_id=v_before.user_id)
       or exists (select 1 from public.payroll_records r where r.id in (select s.payroll_record_id from public.payroll_attendance_snapshots s where s.attendance_id=v_before.id) and r.status <> 'draft') then
      raise exception 'Target % has an unexpected payroll dependency.', v_target.attendance_id;
    end if;
  end loop;

  if exists (select 1 from public.payroll_periods p where p.id=v_period_id and p.status <> 'draft')
     or not exists (select 1 from public.payroll_periods p where p.id=v_period_id and p.status='draft') then
    raise exception 'Payroll period is no longer Draft.';
  end if;

  for v_target in
    select * from (values
      ('d2ff495d-bae1-45da-862b-a9f0dd215df8'::uuid, 732, 9::bigint),
      ('713cafb9-f351-4fdc-ae32-061734996adf'::uuid, 730, 9::bigint),
      ('145d09d4-2520-47bf-8dd4-1455fdcd8953'::uuid, 730, 9::bigint),
      ('810f1e60-699b-42a1-897a-db5c9e8377c4'::uuid, 729, 9::bigint)
    ) as t(attendance_id, old_total, expected_version)
  loop
    update public.attendance a
    set total_worked_minutes = 720
    where a.id=v_target.attendance_id
      and a.total_worked_minutes=v_target.old_total
      and a.attendance_version=v_target.expected_version
    returning a.* into v_after;
    if not found or v_after.total_worked_minutes is distinct from 720
       or v_after.attendance_version is distinct from v_target.expected_version + 1 then
      raise exception 'Target % changed during guarded repair.', v_target.attendance_id;
    end if;
    insert into public.workforce_audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,reason)
    values (p_actor_user_id,'attendance_canonical_total_repaired','attendance',v_after.id,
      jsonb_build_object('total_worked_minutes',v_target.old_total,'attendance_version',v_target.expected_version),
      jsonb_build_object('total_worked_minutes',v_after.total_worked_minutes,'attendance_version',v_after.attendance_version),trim(p_reason));
    attendance_id := v_after.id; previous_total := v_target.old_total; new_total := v_after.total_worked_minutes;
    previous_version := v_target.expected_version; new_version := v_after.attendance_version;
    return next;
  end loop;
end;
$$;

revoke all on function public.workforce_repair_amora_sep01_04_stale_totals(uuid,text) from public, anon, authenticated;
grant execute on function public.workforce_repair_amora_sep01_04_stale_totals(uuid,text) to service_role;

commit;

;
