# Attendance timing and overtime policy

## Implemented behavior

- Agents may clock in against a released `published` or `changed` shift beginning 15 minutes before its scheduled start.
- Attempts made earlier than the 15-minute window are rejected by the database RPC, even if the browser is modified.
- Active overnight shifts remain available after midnight and retain their original scheduled work date.
- Multiple scheduled shifts on the same work date receive separate attendance records.
- Only one attendance record may remain clocked in at a time.
- A shift is no longer available for clock-in after its scheduled end.
- Agents with a released shift cannot bypass timing rules by submitting an unscheduled clock-in request.
- Completed minutes between actual clock-in and scheduled shift start are recorded as pre-shift overtime.
- Completed minutes after scheduled shift end are recorded as post-shift overtime.
- The attendance record stores combined pre-shift and post-shift overtime.
- Late and undertime calculations continue to use the selected published or changed schedule.
- Rest days and unreleased schedules remain unavailable for clock-in.
- Unscheduled attendance remains available only when no relevant released shift is assigned.

## Deployment

Apply the migrations after the existing workforce migrations through `2026070802_workforce_timezone_new_york.sql`, in this order:

```sql
supabase/migrations/2026070803_attendance_early_clock_in_overtime.sql
supabase/migrations/2026070804_attendance_released_schedule_enforcement.sql
supabase/migrations/2026070805_attendance_overnight_multi_shift.sql
```

Then run:

```sql
supabase/verification/attendance_early_clock_in_overtime_check.sql
```

The blocker queries must return zero rows. All function-definition and index checks must return `true`, and all three attendance audit entries must be present.

## Required manual tests

1. Attempt clock-in more than 15 minutes before a published shift. The request must be rejected.
2. Attempt the same request without a schedule ID. It must still be rejected when a released shift exists.
3. Attempt clock-in exactly 15 minutes before the shift. The request must succeed.
4. Clock in 10 minutes early and clock out at the scheduled end. Attendance must show 10 minutes of overtime.
5. Clock in 10 minutes early and clock out 20 minutes late. Attendance must show 30 minutes of overtime.
6. Clock in after the scheduled start but before the scheduled end. Late minutes must be recorded and pre-shift overtime must remain zero.
7. Open Attendance after midnight during a shift that began the previous date. The active overnight shift must appear and allow clock-in.
8. Create two non-overlapping shifts with the same work date. Each shift must allow a separate clock-in and clock-out record.
9. Attempt to clock in to a second shift while another attendance record is still open. The request must be rejected.
10. Attempt clock-in after the selected shift has ended. The request must be rejected.
11. Attempt clock-in against a draft, cancelled, completed, or rest-day schedule. The request must be rejected.
12. With no relevant released shift assigned, confirm that unscheduled attendance remains available.

## Regression test

Run:

```bash
npm test
```

The repository test `tests/attendance-early-clock-in-overtime.test.mjs` verifies the integrated attendance client, overnight schedule range, server-side 15-minute gate, combined overtime calculation, multi-shift uniqueness model, and parallel clock-in prevention.
