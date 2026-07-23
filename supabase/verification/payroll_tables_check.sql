-- Phase 2 Step 1 verification. Returns one row with all checks true.
with required_tables(table_name) as (
  values
    ('agent_rates'),
    ('payroll_periods'),
    ('payroll_records'),
    ('payroll_items'),
    ('payroll_attendance_snapshots'),
    ('payslips'),
    ('payroll_audit_logs')
),
table_checks as (
  select
    count(*) = 7 as all_tables_exist,
    bool_and(c.relrowsecurity) as all_tables_have_rls
  from required_tables required
  join pg_class c on c.relname = required.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
),
browser_privilege_check as (
  select not exists (
    select 1
    from required_tables required
    cross join (values ('anon'), ('authenticated')) browser(role_name)
    where has_table_privilege(
      browser.role_name,
      format('public.%I', required.table_name),
      'SELECT, INSERT, UPDATE, DELETE'
    )
  ) as browser_roles_are_closed
),
foreign_key_checks as (
  select
    exists (
      select 1
      from pg_constraint
      where conname = 'payroll_attendance_snapshots_attendance_id_fkey'
        and contype = 'f'
    ) as snapshots_reference_attendance,
    exists (
      select 1
      from pg_constraint
      where conname = 'payslips_payroll_record_id_fkey'
        and contype = 'f'
    ) as payslips_reference_records
)
select
  table_checks.*,
  browser_privilege_check.*,
  foreign_key_checks.*,
  (
    table_checks.all_tables_exist
    and table_checks.all_tables_have_rls
    and browser_privilege_check.browser_roles_are_closed
    and foreign_key_checks.snapshots_reference_attendance
    and foreign_key_checks.payslips_reference_records
  ) as phase2_step1_ready
from table_checks
cross join browser_privilege_check
cross join foreign_key_checks;
