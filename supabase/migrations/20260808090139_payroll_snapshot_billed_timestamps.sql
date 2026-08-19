alter table public.payroll_attendance_snapshots
  add column if not exists billed_clock_in timestamptz,
  add column if not exists billed_clock_out timestamptz;
