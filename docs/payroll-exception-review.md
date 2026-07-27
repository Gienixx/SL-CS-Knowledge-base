# Payroll exception review

Phase 2 Step 8 gives approved payroll users one review list for issues that
must be resolved before payroll can be calculated or finalized.

## Exceptions checked

- Missing effective rate
- Incomplete or unapproved attendance
- Missing clock-out
- Overtime above the configured review limit
- Duplicate attendance
- Overlapping schedules
- Overlapping payroll periods
- Attendance changed after import
- Scheduled shifts with no attendance entry

Before Step 7 begins, this review will be extended with:

- Schedule changed after pre-plot approval
- Pre-plot missing payroll approval
- Invalid pre-plotted minutes
- Duplicate hour allocation
- Invalid prepaid balance source
- Unresolved prepaid balance

Approved pre-plotted dates will not be treated as missing attendance.
Guaranteed special days without attendance will not be treated as missing
attendance. A valid balance carried to a later payroll will be visible for
review but will not be a blocking exception.

The checks use current attendance, schedules, effective-dated rate coverage,
and the latest imported attendance version. They do not calculate pay or expose
rate amounts.

## Review workflow

The payroll-period page shows each exception with the employee, date, reason,
and blocking status. Payroll users can filter by exception type.

Users who also have attendance-view permission receive a link to the affected
employee and work date in Team Attendance. Users with `manage_agent_rates`
receive a link to rate management for missing-rate issues. The links do not
grant either permission.

## Access boundary

The review is available only to active users with `create_payroll`,
`review_payroll`, `finalize_payroll`, or `reopen_payroll`. General
administrator access alone is not sufficient. The browser calls a secured
database operation that returns issue metadata only; direct rate and snapshot
queries remain restricted by their existing permission-based row-security
policies.
