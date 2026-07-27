# Payroll period and pre-plot management

Revised Phase 2 Step 5 provides the controlled setup stage for each payroll run
and explicitly approves future scheduled hours paid before cutoff.

## What payroll users can do

- Open the Payroll dashboard with an explicit payroll-processing permission.
- Create a draft period with start, end, and payment dates.
- Pay on cutoff or up to three calendar days early under the standard rule.
- Record an override reason when payment is more than three days early.
- Check proposed dates against every active payroll period.
- Load all active and on-leave agents into the period.
- Review employee rate and attendance readiness.
- Open an exact missing-attendance date when separately authorized.
- Review schedules after payment and through cutoff.
- Select eligible ordinary shifts and approve them with one required reason.
- See the captured schedule version, hours, day type, and approval state.

## Early-payment rule

The payment date cannot be after cutoff. A payment date up to three calendar
days before cutoff is within the normal window. Earlier payment remains
possible only when the payroll creator records an override reason. The period
preserves the configured window, number of early days, reason, actor, and
timestamp for audit.

## Pre-plot approval

Only published or changed ordinary schedules with complete start and end times
may be approved. A schedule must belong to an employee loaded into the period,
fall after payment and no later than cutoff, and have no linked attendance.

Approval locks and reads the current schedule in PostgreSQL. The browser sends
only schedule IDs and a reason; it cannot supply trusted hours, employees,
versions, or special-day classifications. The resulting
`payroll_schedule_snapshots` row is immutable.

Rest days and holidays are visible for context but cannot be selected. They
remain guaranteed or additional pay and never create prepaid-hour debt. A
current-version approval removes that shift from missing-attendance readiness
and exceptions. If the schedule later changes, the new version requires
explicit reapproval while the old approval remains preserved.

## Access boundary

The pages require `create_payroll`, `review_payroll`, `finalize_payroll`, or
`reopen_payroll`. Creating periods and approving pre-plots both require
`create_payroll`.

General administrator access does not grant access. Browser users cannot write
directly to payroll periods, records, or schedule snapshots. Period creation
runs through `payroll_create_period`; approval runs through
`payroll_approve_preplots`. Both operations validate authorization and write
payroll audit logs.

Payroll-only users see attendance exceptions without receiving attendance
correction access or links to pages they cannot otherwise open.

## Data boundary

Step 5 creates the period, one draft record per eligible employee, and only the
explicitly approved immutable schedule snapshots. It does not copy attendance
or create prepaid balances.

Step 6 imports approved attendance and will turn the approved schedule
snapshots into prepaid-minute balances. Readiness remains live, and schedule or
attendance versions are never silently replaced.

Step 8 provides the broader exception review. Revised Step 5 already prevents
an approved current schedule version from appearing as missing attendance.
