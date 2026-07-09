# Phase 1, Step 12 — Attendance Correction Workflow

## Status

Implemented through:

- `2026070904_attendance_correction_workflow.sql`
- `2026070905_attendance_original_timestamp_guard.sql`

## User interface

Authorized administrators now see a **Correct** action on `team-attendance.html`.

The correction form supports:

- Effective clock-in
- Effective clock-out
- Attendance status
- Linked schedule
- Administrative notes
- Mandatory correction reason
- Supporting reason notes

The available reason codes are:

- `forgot_clock_in`
- `forgot_clock_out`
- `system_issue`
- `connection_issue`
- `incorrect_schedule`
- `approved_overtime`
- `manager_confirmed`
- `other`

When `other` is selected, written reason notes are mandatory.

## Authorization

Attendance corrections require:

1. An authenticated and active workforce profile.
2. Effective administrator status.
3. An explicit `correct_attendance` permission.

A supervisor with `view_team_attendance` remains read-only.

A payroll user with `manage_payroll` receives no correction capability unless the correction permission is granted separately.

Automatic approval occurs only when the correcting administrator also has `approve_attendance`.

- Complete corrected records become `approved` when the administrator has approval access.
- Otherwise, corrected records become `corrected` and remain pending approval.
- Locked attendance records cannot be corrected.

## Trusted correction transaction

The browser calls:

```text
workforce_correct_attendance(...)
```

The transaction:

1. Locks the employee attendance scope.
2. Checks the explicit correction permission.
3. Validates the reason code and notes.
4. Converts local correction times using the employee timezone.
5. Preserves the existing work date.
6. Validates any replacement schedule against the same employee and work date.
7. Rejects duplicate schedule links and overlapping attendance intervals.
8. Saves the effective clock values, status, schedule, notes, corrector, and correction time.
9. Recalculates all scheduled attendance on the employee work date.
10. Reapplies the 1,200-minute aggregate overtime limit.
11. Updates the review status.
12. Writes an explicit before-and-after event to `workforce_audit_logs`.

## Original timestamp behavior

`original_clock_in` and `original_clock_out` remain immutable after genuine self-service capture.

When an administrator fills a timestamp that was originally missing, the corresponding original value remains null. This prevents an administrative correction from being represented as the originally captured clock event.

The previous effective values are preserved in the correction audit event. Step 13 adds the dedicated structured `attendance_corrections` history table.

## Direct table writes

Step 12 removes authenticated browser privileges for direct attendance inserts, updates, and deletes.

Attendance changes now occur only through trusted security-definer functions:

- Agent clock-in RPC
- Agent clock-out RPC
- Authorized attendance correction RPC

The browser retains read access subject to attendance RLS.

## Schedule correction options

The correction modal loads eligible schedules through:

```text
workforce_list_attendance_correction_schedules(attendance_id)
```

Only schedules belonging to the same employee and preserved work date are returned. Rest days and incomplete shifts are excluded.

## Validation behavior

The server rejects:

- Missing or invalid correction reasons
- `other` without written notes
- Clock-out before clock-in
- Present status without clock-in
- Non-present status with clock timestamps
- A schedule belonging to another employee
- A schedule from another work date
- Duplicate attendance for one schedule
- Duplicate unscheduled attendance on one work date
- Overlapping attendance sessions
- Locked attendance records

## Deployment

Apply the migrations in this order:

```text
supabase/migrations/2026070904_attendance_correction_workflow.sql
supabase/migrations/2026070905_attendance_original_timestamp_guard.sql
```

Then run:

```text
supabase/verification/attendance_correction_workflow_check.sql
```

Every blocker query in section 6 must return zero rows.

## Manual test checklist

Test at least:

1. Correct a clock-in.
2. Correct a missing clock-out.
3. Correct both timestamps.
4. Reassign the linked schedule.
5. Change the attendance status.
6. Enter administrative notes.
7. Confirm that a reason is mandatory.
8. Confirm that `other` requires notes.
9. Confirm that totals recalculate.
10. Confirm that other shifts on the work date recalculate.
11. Confirm that the 20-hour overtime limit remains enforced.
12. Confirm that a correction-only admin produces `corrected` status.
13. Confirm that a correction-and-approval admin produces `approved` status for a complete record.
14. Confirm that supervisors cannot see correction controls.
15. Confirm that payroll-only users cannot correct attendance.
16. Confirm that locked records cannot be corrected.
17. Confirm that overlapping corrected sessions are rejected.
18. Confirm that the audit log contains the previous and new values.

## Step 13 boundary

Step 12 uses `workforce_audit_logs` to preserve before-and-after values and structured reason metadata.

Step 13 must add `attendance_corrections` as the dedicated payroll-sensitive structured history table. The Step 12 correction RPC should then insert one correction-history row within the same transaction.
