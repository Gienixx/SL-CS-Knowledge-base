# Payroll attendance import

Phase 2 Step 6 preserves the approved attendance used by payroll.

## What payroll users can do

- Open a draft or reopened payroll period.
- Import every attendance entry that is currently payroll-ready.
- See how many current attendance snapshots are stored for each employee.
- Run the import again safely. Attendance versions already captured are not duplicated.
- See which payroll records require recalculation after a source attendance change.

The import does not expose rates or calculate pay. Missing, incomplete, or
unapproved attendance remains outside payroll and continues to appear in the
readiness checks.

Approval makes attendance payroll-ready; it does not itself create a payroll
attendance snapshot or settle a prepaid balance. Prepaid fulfillment is
recorded when the authorized payroll import inserts the snapshot. The
append-only snapshot trigger then applies the captured billed minutes through
the normal FIFO allocation rules. Run the import after approvals and after any
correction that changes the approved attendance version.

## Prepaid-hours foundation

The reconciliation tables, schedule versioning, future-attendance guard, and
pre-plot approval workflow are now in place. Authorized payroll users approve
eligible post-payment schedules from the payroll-period page. Approval creates
a prepaid-minute balance without creating a fake attendance row or weakening
the payroll-ready attendance rules.

Later payroll-ready attendance settles the oldest eligible balance through
append-only allocation records. Regular minutes settle first, followed by
normal pre-shift and post-shift overtime. A shortfall remains open and carries
to later eligible attendance until the balance reaches zero. The attendance row
and the finalized source payroll remain unchanged.

Holiday, rest-day, and guaranteed special-day work will remain additional
payable work and will not settle prepaid balances.

## Snapshot integrity

Each imported row stores the employee, schedule, work date, clock times,
regular minutes, overtime components, late and undertime minutes, source
attendance version, source update time, and import time.

Snapshots are append-only. A later attendance correction creates a new source
version and never overwrites an older payroll snapshot. Re-importing captures
the new version while preserving the version previously used.

## Recalculation safeguard

When imported attendance changes, the related non-finalized payroll record is
marked as requiring recalculation and an audit entry records the affected
attendance version. Finalized and void payroll records are not changed.

Only users with `create_payroll` can run an import. Other approved payroll
processors may view import coverage and recalculation status. Browser users
cannot insert, update, or delete snapshot rows directly.
