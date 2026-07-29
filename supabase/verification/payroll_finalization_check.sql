-- Phase 2 Step 10 deployment and finalized-payroll invariants.
select
  to_regprocedure(
    'public.payroll_review_period(uuid,text)'
  ) is not null as review_function_exists_should_be_true,
  to_regprocedure(
    'public.payroll_finalize_period(uuid,text)'
  ) is not null as finalize_function_exists_should_be_true,
  to_regprocedure(
    'public.payroll_reopen_period(uuid,text)'
  ) is not null as reopen_function_exists_should_be_true,
  to_regprocedure(
    'public.payroll_get_period_lifecycle(uuid)'
  ) is not null as lifecycle_function_exists_should_be_true,
  has_function_privilege(
    'anon',
    'public.payroll_finalize_period(uuid,text)',
    'execute'
  ) as anon_can_finalize_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_finalize_period(uuid,text)',
    'execute'
  ) as authenticated_can_call_guarded_finalize_should_be_true,
  has_function_privilege(
    'authenticated',
    'public.payroll_collect_finalization_evidence(uuid)',
    'execute'
  ) as authenticated_can_call_internal_evidence_should_be_false;

select count(*) as invalid_finalized_period_count_should_be_zero
from public.payroll_periods as period
where period.status = 'finalized'
  and (
    period.reviewed_by is null
    or period.reviewed_at is null
    or period.approved_by is null
    or period.approved_at is null
    or period.finalized_by is null
    or period.finalized_at is null
    or period.finalization_version < 1
    or period.finalization_evidence = '{}'::jsonb
  );

select count(*) as invalid_finalized_record_count_should_be_zero
from public.payroll_records as record
join public.payroll_periods as period
  on period.id = record.payroll_period_id
where period.status = 'finalized'
  and record.status <> 'void'
  and (
    record.status <> 'finalized'
    or record.reviewed_by is null
    or record.reviewed_at is null
    or record.finalized_at is null
    or record.requires_recalculation
    or record.gross_pay is distinct from (
      select coalesce(sum(item.amount), 0)
      from public.payroll_items as item
      where item.payroll_record_id = record.id
        and item.item_type = 'earning'
    )
    or record.total_deductions is distinct from (
      select coalesce(sum(item.amount), 0)
      from public.payroll_items as item
      where item.payroll_record_id = record.id
        and item.item_type = 'deduction'
    )
    or record.net_pay is distinct from (
      record.gross_pay - record.total_deductions
    )
  );

select
  tgname,
  tgenabled
from pg_trigger
where tgrelid in (
    'public.payroll_periods'::regclass,
    'public.payroll_records'::regclass,
    'public.payroll_items'::regclass,
    'public.payroll_attendance_snapshots'::regclass,
    'public.payroll_schedule_snapshots'::regclass,
    'public.payroll_hour_allocations'::regclass,
    'public.payslips'::regclass,
    'public.payroll_audit_logs'::regclass
  )
  and tgname in (
    'payroll_periods_finalized_immutable',
    'payroll_records_finalized_immutable',
    'payroll_items_finalized_immutable',
    'payroll_attendance_snapshots_finalized_insert_guard',
    'payroll_schedule_snapshots_finalized_insert_guard',
    'payroll_hour_allocations_finalized_insert_guard',
    'payslips_immutable',
    'payroll_audit_logs_immutable'
  )
order by tgname;

select to_regclass(
  'public.payroll_periods_reviewed_by_idx'
) is not null as reviewer_index_exists_should_be_true;

select
  action,
  count(*) as lifecycle_audit_event_count
from public.payroll_audit_logs
where action in (
  'payroll_period_reviewed',
  'payroll_period_finalized',
  'payroll_period_reopened'
)
group by action
order by action;
