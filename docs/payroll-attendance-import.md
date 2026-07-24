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
