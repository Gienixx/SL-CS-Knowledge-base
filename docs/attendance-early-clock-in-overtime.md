# Attendance early clock-in and overtime policy

## Implemented behavior

- Agents may clock in against a released `published` or `changed` shift beginning 15 minutes before its scheduled start.
- Attempts made earlier than the 15-minute window are rejected by the database RPC, even if the browser is modified.
- Completed minutes between the actual clock-in and scheduled shift start are recorded as pre-shift overtime.
- Completed minutes after the scheduled shift end are recorded as post-shift overtime.
- The attendance record stores the combined pre-shift and post-shift overtime total.
- Late and undertime calculations continue to use the published or changed schedule.
- Rest days and unreleased schedules remain unavailable for clock-in.

## Deployment

Apply the migration after the existing workforce migrations through `2026070802_workforce_timezone_new_york.sql`:

```sql
supabase/migrations/2026070803_attendance_early_clock_in_overtime.sql
```

Then run:

```sql
supabase/verification/attendance_early_clock_in_overtime_check.sql
```

The released-schedule blocker query must return zero rows. The function-definition checks must return `true`.

## Required manual tests

1. Attempt clock-in more than 15 minutes before a published shift. The request must be rejected.
2. Attempt clock-in exactly 15 minutes before the shift. The request must succeed.
3. Clock in 10 minutes early and clock out at the scheduled end. Attendance must show 10 minutes of overtime.
4. Clock in 10 minutes early and clock out 20 minutes late. Attendance must show 30 minutes of overtime.
5. Clock in after the scheduled start. Late minutes must be recorded and pre-shift overtime must remain zero.
6. Attempt clock-in against a draft, cancelled, completed, or rest-day schedule. The request must be rejected.
7. Complete an overnight shift. Clock-out must locate the open attendance record and calculate adjustments from the linked schedule.

## Regression test

Run:

```bash
npm test
```

The repository test `tests/attendance-early-clock-in-overtime.test.mjs` verifies the page integration, browser guard, server-side 15-minute gate, and combined overtime calculation.
