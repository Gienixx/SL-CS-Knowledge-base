-- Definition only. No production repair is executed by this migration.
-- One historical source; follows the approved total-repair/legacy architecture.
begin;
create function public.payroll_repair_jerson_aug17(
  p_attendance_id uuid,
  p_payroll_period_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_attendance_version bigint,
  p_expected_work_date date,
  p_expected_total_worked_minutes integer,
  p_expected_attendance_fingerprint text,
  p_expected_prepaid_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
set timezone = 'UTC'
as $$
declare
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_period public.payroll_periods%rowtype;
  v_record public.payroll_records%rowtype;
  v_blockers text[];
  v_prepaid_before text;
  v_prepaid_after text;
  v_previous_setting text;
  v_updated boolean;
  v_reason constant text := 'Historical schedule/work-date correction plus stale captured-duration total normalization';
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '55000', message = 'Repair requires a fresh READ COMMITTED transaction.';
  end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required.';
  end if;
  if p_attendance_id is distinct from 'a0aa3a5e-3c5c-4718-9da2-5d3264ca8682'::uuid
     or p_payroll_period_id is distinct from 'dd6c75b4-4eb1-4b77-9aa7-82a536eeb15f'::uuid then
    raise exception using errcode = '42501', message = 'Only the verified Jerson Aug 17 source and Aug 16-31 period are allowed.';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles actor
    where actor.user_id = p_actor_user_id and actor.is_system_admin is true
      and actor.employment_status = 'active' and actor.account_deleted_at is null
      and actor.can_manage_payroll is true for share
  ) then
    raise exception using errcode = '42501', message = 'An active system administrator with payroll management is required.';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'A repair reason is required.';
  end if;
  -- The caller cannot bless a different before-state by supplying fresh values.
  if p_expected_attendance_version is distinct from 10
     or p_expected_work_date is distinct from date '2026-08-17'
     or p_expected_total_worked_minutes is distinct from 908
     or p_expected_attendance_fingerprint is distinct from '900d6d7ed76ba114fc83e4a9b2c02ba1'
     or nullif(trim(p_expected_prepaid_fingerprint), '') is null then
    raise exception using errcode = '40001', message = 'Expected manifest does not match the verified historical source.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public.payroll_lifecycle:' || p_payroll_period_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public.payroll_import_attendance:' || p_payroll_period_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'b303c569-c808-409f-958e-7bc89868b07f')::bigint);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public.payroll_prepaid_hours:b303c569-c808-409f-958e-7bc89868b07f', 0));

  -- Short, bounded write exclusion also protects ABSENCE predicates from new
  -- rows inserted by paths that do not use the application advisory locks.
  -- Reads remain available. No table content or security policy is changed.
  lock table public.payroll_periods, public.payroll_records,
    public.attendance, public.payroll_attendance_snapshots,
    public.payroll_schedule_snapshots, public.payroll_items,
    public.payroll_hour_allocations, public.payroll_prepaid_hours,
    public.payslips in share row exclusive mode;

  select * into v_period from public.payroll_periods where id = p_payroll_period_id for update;
  if not found or v_period.status is distinct from 'draft'
     or v_period.finalization_version is distinct from 0
     or v_period.period_start is distinct from date '2026-08-16'
     or v_period.period_end is distinct from date '2026-08-31'
     or v_period.approved_at is not null or v_period.approved_by is not null
     or v_period.reviewed_at is not null or v_period.reviewed_by is not null
     or v_period.finalized_at is not null or v_period.finalized_by is not null then
    raise exception using errcode = '55000', message = 'The period must remain draft, unreviewed and unfinalized.';
  end if;
  if exists (select 1 from public.payroll_records r where r.payroll_period_id = v_period.id
    and (r.status is distinct from 'draft' or r.calculated_at is not null or r.calculated_by is not null
      or r.reviewed_at is not null or r.reviewed_by is not null or r.finalized_at is not null))
     or exists (select 1 from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id
       where r.payroll_period_id = v_period.id)
     or exists (select 1 from public.payslips s join public.payroll_records r on r.id = s.payroll_record_id
       where r.payroll_period_id = v_period.id) then
    raise exception using errcode = '55000', message = 'Calculated/reviewed/finalized payroll, items or payslips block repair.';
  end if;
  select * into v_record from public.payroll_records r
  where r.id = '1f60993d-1416-4576-a415-00909ba7e424'::uuid
    and r.payroll_period_id = v_period.id
    and r.employee_id = 'b303c569-c808-409f-958e-7bc89868b07f'::uuid for update;
  if not found then
    raise exception using errcode = '55000', message = 'The verified draft employee payroll record is required.';
  end if;

  select * into v_before from public.attendance where id = p_attendance_id for update;
  if not found or v_before.attendance_version is distinct from 10
     or v_before.work_date is distinct from date '2026-08-17'
     or v_before.total_worked_minutes is distinct from 908
     or md5(to_jsonb(v_before)::text) is distinct from p_expected_attendance_fingerprint then
    raise exception using errcode = '40001', message = 'Attendance no longer matches the exact verified before-state.';
  end if;
  -- Explicit invariants supplement the full-row fingerprint, including all
  -- captured/original timestamps, reviewer identity and approval metadata.
  if v_before.user_id is distinct from 'b303c569-c808-409f-958e-7bc89868b07f'::uuid
     or v_before.voided_at is not null
     or v_before.attendance_status is distinct from 'present'
     or v_before.review_status is distinct from 'approved'
     or v_before.payroll_approved_at is distinct from timestamptz '2026-08-23 15:01:47.212071+00'
     or v_before.reviewed_at is distinct from v_before.payroll_approved_at
     or v_before.reviewed_by is distinct from '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e'::uuid
     or v_before.billed_clock_in is distinct from timestamptz '2026-08-16 19:00:00+00'
     or v_before.billed_clock_out is distinct from timestamptz '2026-08-17 10:00:00+00'
     or public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out) is distinct from 900
     or v_before.regular_minutes is distinct from 0
     or v_before.rest_day_overtime_minutes is distinct from 900
     or v_before.total_overtime_minutes is distinct from 900
     or v_before.overtime_minutes is distinct from 900
     or v_before.pre_shift_overtime_minutes is distinct from 0
     or v_before.post_shift_overtime_minutes is distinct from 0
     or v_before.holiday_overtime_minutes is distinct from 0 then
    raise exception using errcode = '40001', message = 'Identity, approval, billed duration or classification changed.';
  end if;
  select * into v_schedule from public.work_schedules where id = v_before.schedule_id for share;
  if not found or v_schedule.id is distinct from '3c2c440d-fee6-4ea0-9c24-471d15b8fc79'::uuid
     or v_schedule.user_id is distinct from v_before.user_id
     or v_schedule.schedule_version is distinct from 1
     or v_schedule.shift_date is distinct from date '2026-08-16'
     or v_schedule.timezone is distinct from 'America/New_York'
     or v_schedule.status is distinct from 'published'
     or v_schedule.is_rest_day is distinct from true
     or v_schedule.is_holiday is distinct from false
     or v_schedule.is_leave is distinct from false or v_schedule.is_absent is distinct from false
     or v_schedule.shift_start is not null or v_schedule.shift_end is not null
     or (v_before.billed_clock_in at time zone v_schedule.timezone)::date is distinct from v_schedule.shift_date then
    raise exception using errcode = '40001', message = 'The verified Aug 16 rest-day schedule changed.';
  end if;

  -- Check the allocation graph first so a settlement is identified explicitly,
  -- even though its required parent snapshot would independently block repair.
  if exists (select 1 from public.payroll_hour_allocations x
    join public.payroll_attendance_snapshots s on s.id = x.attendance_snapshot_id
    where s.attendance_id = v_before.id or s.schedule_id = v_schedule.id) then
    raise exception using errcode = '55000', message = 'A target allocation or settlement blocks repair.';
  end if;
  if exists (select 1 from public.payroll_attendance_snapshots s
    where s.attendance_id = v_before.id) then
    raise exception using errcode = '55000', message = 'Any current or historical attendance snapshot blocks repair.';
  end if;
  if exists (select 1 from public.payroll_items i
    left join public.payroll_attendance_snapshots s on s.id = i.source_attendance_snapshot_id
    join public.payroll_records r on r.id = i.payroll_record_id
    where s.attendance_id = v_before.id or i.source_schedule_id = v_schedule.id
      or (r.employee_id = v_before.user_id and i.work_date in (date '2026-08-16', date '2026-08-17'))
      or i.metadata::text like '%' || v_before.id::text || '%') then
    raise exception using errcode = '55000', message = 'A target/equivalent payroll item blocks repair.';
  end if;
  if exists (select 1 from public.payroll_schedule_snapshots s where s.schedule_id = v_schedule.id)
     or exists (select 1 from public.payroll_attendance_snapshots s where s.employee_id = v_before.user_id
       and (s.schedule_id = v_schedule.id
         or (coalesce(s.billed_clock_in, s.clock_in) < v_before.billed_clock_out
           and coalesce(s.billed_clock_out, s.clock_out) > v_before.billed_clock_in))) then
    raise exception using errcode = '55000', message = 'An equivalent snapshot source blocks repair.';
  end if;
  if exists (select 1 from public.attendance a
    where a.user_id = v_before.user_id and a.id <> v_before.id and a.voided_at is null
      and (a.work_date = date '2026-08-16' or a.schedule_id = v_schedule.id
        or (a.clock_in < v_before.clock_out and coalesce(a.clock_out, 'infinity'::timestamptz) > v_before.clock_in)
        or (coalesce(a.billed_clock_in, a.clock_in) < v_before.billed_clock_out
          and coalesce(a.billed_clock_out, a.clock_out, 'infinity'::timestamptz) > v_before.billed_clock_in))) then
    raise exception using errcode = '55000', message = 'Conflicting or overlapping attendance blocks repair.';
  end if;
  select payroll_readiness_blockers into v_blockers
  from public.workforce_attendance_payroll_readiness where id = v_before.id;
  if not found or v_blockers is distinct from array['schedule_work_date_mismatch', 'total_worked_mismatch']::text[] then
    raise exception using errcode = '55000', message = 'Readiness must contain exactly the two verified blockers.';
  end if;
  select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), ''))
  into v_prepaid_before from public.payroll_prepaid_hours p where p.employee_id = v_before.user_id;
  if v_prepaid_before is distinct from p_expected_prepaid_fingerprint then
    raise exception using errcode = '40001', message = 'Employee prepaid state changed since preflight.';
  end if;

  v_previous_setting := current_setting('workforce.correction_recalculation', true);
  perform set_config('workforce.correction_recalculation', 'true', true);
  begin
    update public.attendance
    set work_date = date '2026-08-16', total_worked_minutes = 900
    where id = v_before.id and attendance_version = 10
      and work_date = date '2026-08-17' and total_worked_minutes = 908
    returning * into v_after;
    v_updated := found;
  exception when others then
    perform set_config('workforce.correction_recalculation', coalesce(v_previous_setting, 'false'), true);
    raise;
  end;
  perform set_config('workforce.correction_recalculation', coalesce(v_previous_setting, 'false'), true);
  if not v_updated or v_after.work_date is distinct from date '2026-08-16'
     or v_after.total_worked_minutes is distinct from 900
     or v_after.attendance_version is distinct from 11
     or (to_jsonb(v_after) - array['work_date','total_worked_minutes','attendance_version','updated_at'])
       is distinct from (to_jsonb(v_before) - array['work_date','total_worked_minutes','attendance_version','updated_at']) then
    raise exception using errcode = '55000', message = 'Repair changed an unauthorized attendance field.';
  end if;
  if not exists (select 1 from public.workforce_attendance_payroll_readiness
    where id = v_after.id and is_payroll_ready and cardinality(payroll_readiness_blockers) = 0) then
    raise exception using errcode = '55000', message = 'Repaired attendance is not payroll ready.';
  end if;
  select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), ''))
  into v_prepaid_after from public.payroll_prepaid_hours p where p.employee_id = v_before.user_id;
  if v_prepaid_after is distinct from v_prepaid_before
     or exists (select 1 from public.payroll_attendance_snapshots where attendance_id = v_after.id)
     or (select to_jsonb(r) from public.payroll_records r where r.id = v_record.id) is distinct from to_jsonb(v_record)
     or (select to_jsonb(s) from public.work_schedules s where s.id = v_schedule.id) is distinct from to_jsonb(v_schedule) then
    raise exception using errcode = '55000', message = 'Repair changed a payroll dependency or linked schedule.';
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id, action, entity_type, entity_id, payroll_period_id, payroll_record_id,
    before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id, 'payroll_jerson_aug17_work_date_total_repaired', 'attendance', v_after.id,
    v_period.id, v_record.id, to_jsonb(v_before), to_jsonb(v_after),
    v_reason || '. ' || trim(p_reason),
    jsonb_build_object('repair_type', 'single_historical_aug17_source',
      'schedule_before', to_jsonb(v_schedule), 'attendance_fingerprint', p_expected_attendance_fingerprint,
      'prepaid_fingerprint', v_prepaid_before, 'payroll_import_executed', false,
      'approval_preserved', true, 'classification_preserved', true)
  );
  return jsonb_build_object('attendance_id', v_after.id, 'before', to_jsonb(v_before),
    'after', to_jsonb(v_after), 'is_payroll_ready', true, 'payroll_readiness_blockers', '[]'::jsonb);
end;
$$;
-- Only this new RPC gets the existing service-only execution contract.
alter function public.payroll_repair_jerson_aug17(uuid,uuid,uuid,text,bigint,date,integer,text,text) owner to postgres;
revoke all on function public.payroll_repair_jerson_aug17(uuid,uuid,uuid,text,bigint,date,integer,text,text) from public, anon, authenticated;
grant execute on function public.payroll_repair_jerson_aug17(uuid,uuid,uuid,text,bigint,date,integer,text,text) to service_role;
comment on function public.payroll_repair_jerson_aug17(uuid,uuid,uuid,text,bigint,date,integer,text,text) is
  'Single historical Jerson Aug 17 source only: work_date Aug 17 to Aug 16, total 908 to 900, version 10 to 11; preserves approval and RDOT; never imports/calculates payroll.';
commit;
