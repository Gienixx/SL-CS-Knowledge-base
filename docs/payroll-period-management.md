# Payroll period management

Step 5 introduces the controlled setup stage for each payroll run.

## What payroll users can do

- Open the Payroll dashboard from Home when they have an explicit payroll-processing permission.
- Create a draft payroll period with start, end, and payment dates.
- Check proposed dates against every active payroll period before creation.
- Load all active and on-leave agents into the new period.
- Open a period and review employee-by-employee rate and attendance readiness.
- See missing rates, incomplete attendance, missing attendance entries, missing clock-outs, and records awaiting approval.
- Open a missing attendance entry in Team Attendance, filtered to the affected employee and work date, when they also have attendance-view permission.

## Access boundary

The pages require at least one of `create_payroll`, `review_payroll`,
`finalize_payroll`, or `reopen_payroll`. Creation itself requires
`create_payroll`.

General administrator access does not grant access to these pages. Browser
users cannot insert directly into `payroll_periods` or `payroll_records`; draft
creation runs through the audited `payroll_create_period` database operation.
Payroll-only users see attendance exceptions without receiving links into Team
Attendance or gaining attendance correction access.

## Data boundary

Step 5 creates the period and one draft payroll record for each eligible
employee. It does not copy attendance into payroll.

Approved attendance is imported into immutable, versioned payroll attendance
snapshots in Step 6. Readiness remains a live check; the period page now also
shows which current attendance versions have been preserved. Changes after
import flag non-finalized payroll records for recalculation.
