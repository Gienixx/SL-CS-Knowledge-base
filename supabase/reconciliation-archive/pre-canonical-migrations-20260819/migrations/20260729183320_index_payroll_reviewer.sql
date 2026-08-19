-- Cover the Step 10 reviewer foreign key for lifecycle and audit lookups.

create index payroll_periods_reviewed_by_idx
  on public.payroll_periods (reviewed_by, reviewed_at desc)
  where reviewed_by is not null;
