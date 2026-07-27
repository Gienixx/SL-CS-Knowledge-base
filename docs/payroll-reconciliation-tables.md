# Payroll reconciliation tables

Revised Phase 2 Step 1 adds the database foundation for hours paid before they
are rendered.

## Tables

### `payroll_schedule_snapshots`

Stores the exact approved version of a pre-plotted schedule. Scheduled minutes
are generated from the captured start and end timestamps. Snapshots are
immutable and keep their approval reason, approver, schedule version, and
special-day classification.

### `payroll_prepaid_hours`

Stores one prepaid-minute balance for an approved schedule snapshot. Remaining
minutes and status are generated from the prepaid and settled totals. The source
employee, payroll record, schedule snapshot, and original prepaid minutes
cannot be changed.

A balance may be voided or superseded without deleting its history.

### `payroll_hour_allocations`

Append-only ledger showing which later approved attendance snapshot settled a
prepaid balance. Recalculations use reversal rows instead of editing or deleting
earlier allocations.

Only these minute categories may settle a balance:

- Regular minutes
- Normal pre-shift overtime
- Normal post-shift overtime

Rest-day and holiday work are deliberately excluded so they remain additional
pay.

## Supporting changes

- `work_schedules.schedule_version` now increments on every schedule update.
- Payroll attendance snapshots preserve rest-day and holiday overtime details
  from the exact attendance version.
- Composite foreign keys prevent an allocation from combining records belonging
  to different employees.
- FIFO and source-record indexes support efficient balance processing.
- Every payroll foreign key has a covering index, including the original
  payroll tables and the new reconciliation tables.

## Access boundary

The three tables have RLS enabled. Approved payroll processors may read them.
Agents, anonymous users, and general administrators without payroll permissions
cannot read the ledger. Browser users cannot insert, update, or delete rows;
later payroll workflows must use audited server-side operations.
