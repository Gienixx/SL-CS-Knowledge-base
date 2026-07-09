# Phase 1, Step 9 — Trusted Attendance Calculations

## Status

Implemented on the `phase1-step9-attendance-calculations` branch. The migration must be applied and verified in the internal Supabase environment before Step 9 is marked complete.

## Migration

`supabase/migrations/2026070901_attendance_structured_calculation.sql`

## Calculation architecture

Step 9 introduces one calculation path for clock actions and future corrections.

### `workforce_calculate_attendance(...)`

This internal PostgreSQL function receives:

- scheduled start and end
- effective clock-in and clock-out
- scheduled work date
- IANA timezone
- overtime minutes still available for the employee work date

It returns:

- pre-shift overtime minutes
- regular minutes
- post-shift overtime minutes
- total overtime minutes
- total worked minutes
- late minutes
- undertime minutes

The function rejects invalid time order, invalid timezones, invalid schedule intervals, and schedule dates that do not match the supplied work date in the schedule timezone.

### `workforce_recalculate_attendance(attendance_id)`

This internal security-definer function loads and locks the attendance record, verifies its linked schedule, checks for overlapping assigned shifts, calculates the remaining overtime allowance, writes all structured totals, and returns the updated attendance row.

### `workforce_recalculate_attendance_work_date(user_id, work_date)`

This function recalculates scheduled records in shift order. It gives deterministic overtime allocation when an employee has multiple non-overlapping shifts on one scheduled work date.

The internal calculation functions are not executable by `anon` or ordinary `authenticated` clients. Browser clients continue to use only `workforce_clock_in` and `workforce_clock_out`.

## Time classification

For a completed attendance interval:

- Time before scheduled start is pre-shift overtime.
- Time overlapping the scheduled interval is regular time.
- Time after scheduled end is post-shift overtime.
- Late minutes measure clock-in after scheduled start.
- Undertime measures the scheduled period remaining after an early clock-out.
- Total worked minutes remain the actual whole elapsed minutes between effective clock-in and clock-out.

For an open attendance session, pre-shift overtime and lateness can be calculated immediately. Regular, post-shift, worked, and undertime values are finalized at clock-out.

Unscheduled attendance remains supported for compatibility, but it does not receive fabricated regular or overtime classifications.

## Overtime ceiling

The maximum credited overtime is 1,200 minutes, or 20 hours, per employee per scheduled work date.

The recalculator sums all other attendance records for the same employee and work date, determines the remaining allowance, then credits pre-shift overtime first and post-shift overtime from the remaining balance.

Actual worked time is still preserved when overtime exceeds the credit ceiling. Only credited overtime is capped.

## Overnight and multiple shifts

Overnight shifts use stored `timestamptz` boundaries and preserve the schedule’s `shift_date` as the attendance `work_date`.

Multiple shifts on one work date are recalculated in scheduled start order. Attendance records linked to overlapping scheduled shifts are rejected rather than double-counted.

## Open-session enforcement

The migration adds a partial unique index that permits only one open attendance row per employee:

`attendance_one_open_session_per_user_idx`

The clock RPCs also retain advisory locking and explicit open-session checks, preventing parallel requests from creating overlapping sessions.

## Compatibility

The Attendance page and its RPC signatures do not change.

- `workforce_clock_in(schedule_id)` validates and records the clock-in, then calls the trusted recalculator.
- `workforce_clock_out()` records the clock-out, then calls the same recalculator.
- `clock_in` and `clock_out` remain the effective timestamps.
- `overtime_minutes` remains synchronized with `total_overtime_minutes`.
- immutable original timestamps from Step 8 remain unchanged.

The migration attempts to backfill valid schedule-linked historical attendance by employee and work date. Any work date that cannot be recalculated is left unchanged and emits a PostgreSQL warning for investigation.

## Verification

Run:

`supabase/verification/attendance_structured_calculation_check.sql`

The verification script checks:

- required function signatures
- normal, late/undertime, capped-overtime, and overnight examples
- internal function privileges
- one-open-session enforcement
- aggregate overtime above 1,200 minutes
- schedule employee and work-date mismatches
- unresolved structured calculations
- inconsistent structured totals
- overlapping assigned shifts
- clock RPC delegation
- the migration audit marker

Every blocker query in section 5 must return zero rows.

## Automated test

Run:

`node --experimental-default-type=module --test tests/attendance-structured-calculation.test.mjs`

Then run the complete repository suite:

`npm test`

## Deployment sequence

1. Back up the internal Supabase database.
2. Confirm Step 8 migration `2026070807_attendance_review_storage.sql` is applied.
3. Resolve any employee with more than one open attendance row.
4. Apply `2026070901_attendance_structured_calculation.sql`.
5. Review any backfill warnings.
6. Run `attendance_structured_calculation_check.sql`.
7. Run the repository test suite.
8. Test clock-in and clock-out using a regular agent in the `America/New_York` workforce timezone.
9. Test early clock-in, normal time, post-shift overtime, overnight work, multiple shifts, and the 20-hour aggregate ceiling.
10. Do not mark Step 9 complete until all blocker queries return zero rows.
