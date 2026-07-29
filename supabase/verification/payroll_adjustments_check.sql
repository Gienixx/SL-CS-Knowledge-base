-- Phase 2 Step 9 deployment, privacy, and stored-total invariants.
select
  to_regprocedure(
    'public.payroll_save_adjustment(uuid,uuid,text,text,numeric,text,text)'
  ) is not null as save_adjustment_exists_should_be_true,
  to_regprocedure(
    'public.payroll_remove_adjustment(uuid,text,text)'
  ) is not null as remove_adjustment_exists_should_be_true,
  to_regprocedure(
    'public.payroll_get_period_adjustments(uuid)'
  ) is not null as adjustment_review_exists_should_be_true,
  has_function_privilege(
    'anon',
    'public.payroll_save_adjustment(uuid,uuid,text,text,numeric,text,text)',
    'execute'
  ) as anon_can_save_adjustment_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_save_adjustment(uuid,uuid,text,text,numeric,text,text)',
    'execute'
  ) as authenticated_can_save_adjustment_should_be_true,
  has_function_privilege(
    'authenticated',
    'public.payroll_rebuild_record_totals(uuid)',
    'execute'
  ) as authenticated_can_rebuild_totals_should_be_false;

select count(*) as exposed_private_note_count_should_be_zero
from public.payroll_items
where correction_notes is not null;

select count(*) as invalid_manual_item_count_should_be_zero
from public.payroll_items
where is_manual
  and (
    item_code not in ('manual_earning', 'manual_deduction')
    or amount <= 0
    or rate_id is not null
    or source_attendance_snapshot_id is not null
    or source_schedule_snapshot_id is not null
    or source_schedule_id is not null
    or source_schedule_version is not null
  );

select count(*) as manual_total_mismatch_count_should_be_zero
from public.payroll_records as record
where record.calculated_at is not null
  and (
    record.gross_pay is distinct from (
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
  action,
  count(*) as adjustment_audit_event_count
from public.payroll_audit_logs
where action in (
  'payroll_adjustment_added',
  'payroll_adjustment_updated',
  'payroll_adjustment_removed'
)
group by action
order by action;
