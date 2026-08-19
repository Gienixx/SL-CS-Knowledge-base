-- Complete the Phase 2 payroll-table foreign-key indexes identified by the
-- Supabase performance advisor. Partial indexes are used for nullable actors.

begin;

create index agent_rates_created_by_idx
  on public.agent_rates (created_by)
  where created_by is not null;

create index payroll_periods_created_by_idx
  on public.payroll_periods (created_by);
create index payroll_periods_approved_by_idx
  on public.payroll_periods (approved_by)
  where approved_by is not null;
create index payroll_periods_finalized_by_idx
  on public.payroll_periods (finalized_by)
  where finalized_by is not null;
create index payroll_periods_reopened_by_idx
  on public.payroll_periods (reopened_by)
  where reopened_by is not null;

create index payroll_records_calculated_by_idx
  on public.payroll_records (calculated_by)
  where calculated_by is not null;
create index payroll_records_reviewed_by_idx
  on public.payroll_records (reviewed_by)
  where reviewed_by is not null;

create index payroll_items_snapshot_idx
  on public.payroll_items (source_attendance_snapshot_id)
  where source_attendance_snapshot_id is not null;
create index payroll_items_created_by_idx
  on public.payroll_items (created_by)
  where created_by is not null;

create index payroll_attendance_snapshots_schedule_idx
  on public.payroll_attendance_snapshots (schedule_id);

create index payslips_generated_by_idx
  on public.payslips (generated_by);

create index payroll_schedule_snapshots_record_employee_idx
  on public.payroll_schedule_snapshots (payroll_record_id, employee_id);

create index payroll_prepaid_hours_source_composite_idx
  on public.payroll_prepaid_hours (
    source_schedule_snapshot_id,
    source_payroll_record_id,
    employee_id
  );

create index payroll_hour_allocations_prepaid_employee_idx
  on public.payroll_hour_allocations (prepaid_hour_id, employee_id);

create index payroll_hour_allocations_attendance_record_employee_idx
  on public.payroll_hour_allocations (
    attendance_snapshot_id,
    destination_payroll_record_id,
    employee_id
  );

commit;
