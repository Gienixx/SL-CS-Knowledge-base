-- Capture future V2 Committed Hours inputs on the employee payroll record.
-- This table is only a calculation snapshot; the read-only payslip path never
-- inserts into it.
create table public.payroll_v2_committed_hours_snapshots (
  id uuid primary key default gen_random_uuid(),
  payroll_v2_record_id uuid not null,
  employee_user_id uuid not null references public.profiles(user_id) on delete restrict,
  work_date date not null,
  commitment_source_id uuid not null,
  expected_committed_minutes integer not null,
  qualifying_approved_payroll_ready_minutes integer not null,
  covered_committed_minutes integer not null,
  remaining_committed_minutes integer not null,
  source_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint payroll_v2_committed_hours_snapshots_record_employee_fkey
    foreign key (payroll_v2_record_id, employee_user_id)
    references public.payroll_v2_records(id, employee_user_id) on delete restrict,
  constraint payroll_v2_committed_hours_snapshots_source_key
    unique (payroll_v2_record_id, commitment_source_id),
  constraint payroll_v2_committed_hours_snapshots_minutes_check
    check (
      expected_committed_minutes >= 0
      and qualifying_approved_payroll_ready_minutes >= 0
      and covered_committed_minutes >= 0
      and remaining_committed_minutes >= 0
      and covered_committed_minutes <= expected_committed_minutes
      and covered_committed_minutes <= qualifying_approved_payroll_ready_minutes
      and covered_committed_minutes + remaining_committed_minutes = expected_committed_minutes
    ),
  constraint payroll_v2_committed_hours_snapshots_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create index payroll_v2_records_period_fk_idx
  on public.payroll_v2_records (payroll_v2_period_id);
create index payroll_v2_attendance_snapshots_record_employee_fk_idx
  on public.payroll_v2_attendance_snapshots (payroll_v2_record_id, employee_user_id);
create index payroll_v2_manual_earnings_employee_fk_idx
  on public.payroll_v2_manual_earnings (employee_user_id);
create index payroll_v2_manual_earnings_created_by_fk_idx
  on public.payroll_v2_manual_earnings (created_by);
create index payroll_v2_manual_earnings_approved_by_fk_idx
  on public.payroll_v2_manual_earnings (approved_by);
create index payroll_v2_committed_hours_snapshots_record_employee_fk_idx
  on public.payroll_v2_committed_hours_snapshots (payroll_v2_record_id, employee_user_id);
create index payroll_v2_committed_hours_snapshots_employee_date_idx
  on public.payroll_v2_committed_hours_snapshots (employee_user_id, work_date);

alter table public.payroll_v2_committed_hours_snapshots enable row level security;
revoke all on table public.payroll_v2_committed_hours_snapshots
  from public, anon, authenticated;
grant all on table public.payroll_v2_committed_hours_snapshots to service_role;

comment on table public.payroll_v2_committed_hours_snapshots is
  'V2-only calculation snapshot of the exact Committed Hours inputs and coverage for each source commitment. No legacy prepaid balances are stored here.';

;
