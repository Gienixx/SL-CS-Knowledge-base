begin;

do $migration$
declare
  v_definition text;
  v_old constant text := $old$
  -- Lock the full immutable period artifact set before comparing both the
  -- target fingerprints and the period-level fingerprints.
  perform 1
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of snapshot;

  perform 1
  from public.payroll_hour_allocations as allocation
  join public.payroll_records as record
    on record.id = allocation.destination_payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of allocation;

  perform 1
  from public.payroll_prepaid_hours as prepaid
  where exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
      and allocation.prepaid_hour_id = prepaid.id
  )
  for update of prepaid;

  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_period_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_period_allocation_fingerprint
  from (
    select 'allocation:' || to_jsonb(allocation)::text as fingerprint_part
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
    union all
    select distinct 'prepaid:' || to_jsonb(prepaid)::text as fingerprint_part
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_hour_allocations as allocation
      on allocation.prepaid_hour_id = prepaid.id
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
  ) as part;

  if v_period_snapshot_fingerprint <> trim(p_expected_period_snapshot_fingerprint)
     or v_period_allocation_fingerprint <> trim(p_expected_period_allocation_fingerprint) then
    raise exception using errcode = '40001',
      message = 'Period snapshot or allocation fingerprint changed since the dry run.';
  end if;
$old$;
  v_new constant text := $new$
  -- Candidate revision: serialize only the target immutable artifact set.
  perform 1 from public.payroll_attendance_snapshots as snapshot
  where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid
  for update;
  perform 1 from public.payroll_hour_allocations as allocation
  join public.payroll_attendance_snapshots as snapshot on snapshot.id = allocation.attendance_snapshot_id
  where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid
  for update of allocation;
  perform 1 from public.payroll_prepaid_hours as prepaid
  where prepaid.id in (
    select distinct allocation.prepaid_hour_id
    from public.payroll_hour_allocations as allocation
    join public.payroll_attendance_snapshots as snapshot on snapshot.id = allocation.attendance_snapshot_id
    where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid
  )
  for update of prepaid;
  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_period_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid;
  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_period_allocation_fingerprint
  from (
    select 'allocation:' || to_jsonb(allocation)::text as fingerprint_part
    from public.payroll_hour_allocations as allocation
    join public.payroll_attendance_snapshots as snapshot on snapshot.id = allocation.attendance_snapshot_id
    where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid
    union all
    select distinct 'prepaid:' || to_jsonb(prepaid)::text as fingerprint_part
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_hour_allocations as allocation on allocation.prepaid_hour_id = prepaid.id
    join public.payroll_attendance_snapshots as snapshot on snapshot.id = allocation.attendance_snapshot_id
    where snapshot.attendance_id = '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid
  ) as part;
  if v_period_snapshot_fingerprint <> trim(p_expected_period_snapshot_fingerprint)
     or v_period_allocation_fingerprint <> trim(p_expected_period_allocation_fingerprint) then
    raise exception using errcode = '40001', message = 'Target snapshot or allocation context changed since the dry run.';
  end if;
$new$;
begin
  select pg_get_functiondef(
    'public.payroll_reconcile_jerson_legacy_aug18(uuid,jsonb,uuid,text,text,text,text,text,text,text)'::regprocedure
  ) into v_definition;

  if v_definition is null or strpos(v_definition, v_old) = 0 then
    raise exception using errcode = '55000',
      message = 'The deployed legacy RPC is not the expected repository implementation.';
  end if;
  if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception using errcode = '55000',
      message = 'The expected broad fingerprint block was not found exactly once.';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$migration$;

comment on function public.payroll_reconcile_jerson_legacy_aug18(
  uuid, jsonb, uuid, text, text, text, text, text, text, text
) is
  'Single-attendance Jerson legacy repair with target-scoped immutable artifact context guards; normal importer performs snapshot and prepaid reconciliation.';

commit;

;
