# Phase 1, Step 17 — Complete Attendance Cycle

## Safety boundary

The attendance cycle runs against the production Supabase functions using the
dedicated Test identity. All schedules, attendance, corrections, leave records,
and audit rows created by the test are inside a rollback-only subtransaction.
The three recurring schedule configuration tables are checksummed before and
after the cycle.

The test does not call the weekly schedule generator, enroll schedules into a
template, update template days, or change active template assignments. Existing
automated recurring schedules remain the source for real employee schedules.

## Cycle coverage

The executable verification covers:

- Normal shift clock-in and calculation
- Several-hours-early clock-in
- Automatic movement from pre-shift overtime into regular time
- Post-shift and combined overtime
- Overnight work
- Two non-overlapping shifts on one work date
- Rejection of a second open attendance session
- Missing clock-out detection
- Administrative clock-in and clock-out correction
- Structured reason and correction-history logging
- Trusted recalculation after correction
- Attendance approval and payroll readiness
- Leave submission, approval, and payroll-visible leave attendance
- Supervisor Test Team visibility with no outside-team rows
- Regular-agent attendance row isolation through RLS
- Overtime near and beyond the aggregate 20-hour ceiling

## Execution

Run `supabase/verification/complete_attendance_cycle_check.sql` through an
administrative database connection. A successful result is one JSON object with
every scenario set to `true`, including `rollback_only`,
`agent_self_record_isolation`, and
`recurring_schedule_automation_preserved`.

After the database cycle, verify the production Pages deployment serves Login,
Attendance, Team Attendance, Leave Requests, and Workforce Management, and that
a protected Pages Function rejects an unauthenticated request.

Step 17 supplies the operational evidence for the Step 18 production-release
gate. It does not itself authorize Phase 1 final release.

## Execution record — July 22, 2026

The rollback-only cycle completed successfully on the live Supabase project.
Every scenario in the Step 17 JSON report returned `true`.

- Residual Step 17 schedules: 0
- Residual Step 17 leave requests: 0
- Residual Step 17 corrections: 0
- Active recurring schedule assignments after the cycle: 9
- Recurring templates, days, and assignments: checksums unchanged
- July 1–15 payroll-readiness blockers: 0
- Production Pages deployment: `51184c58-e98d-44b3-8bec-c33350be31f0`
- Production live-page checks: 5 of 5 returned HTTP 200
- Protected Pages Function without authentication: HTTP 401
- Step 17 and release-gate tests: 10 passed, 0 failed

The five stale schedule-default and table-pagination expectations were updated
before the Step 18 release. The broader repository suite now passes all 274
tests with no failures.
