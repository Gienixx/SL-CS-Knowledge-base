# Payroll period management

Step 5 introduces the controlled setup stage for each payroll run.

## What payroll users can do

- Open the Payroll dashboard from Home when they have an explicit payroll-processing permission.
- Create a draft payroll period with start, end, and payment dates.
- Check proposed dates against every active payroll period before creation.
- Load all active and on-leave agents into the new period.
- Open a period and review employee-by-employee rate and attendance readiness.
- See missing rates, incomplete attendance, missing attendance entries, missing clock-outs, and records awaiting approval.

## Access boundary

The pages require at least one of `create_payroll`, `review_payroll`,
`finalize_payroll`, or `reopen_payroll`. Creation itself requires
`create_payroll`.

General administrator access does not grant access to these pages. Browser
users cannot insert directly into `payroll_periods` or `payroll_records`; draft
creation runs through the audited `payroll_create_period` database operation.

## Data boundary

Step 5 creates the period and one draft payroll record for each eligible
employee. It does not copy attendance into payroll.

Approved attendance is imported into immutable payroll attendance snapshots in
Step 6. Readiness displayed in Step 5 is a live pre-import check and does not
change attendance or payroll calculations.
