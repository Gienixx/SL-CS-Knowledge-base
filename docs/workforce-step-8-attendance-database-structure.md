# Phase 1, Step 8 — Attendance Database Structure

## Status

Implemented on the `phase1-step8-attendance-structure` branch. Apply and verify the migration in the internal Supabase environment before marking the step complete.

## Migration

`supabase/migrations-legacy/2026070807_attendance_review_storage.sql`

The migration is additive and preserves the current attendance interface and Step 7 clock RPC contracts.

## New attendance fields

| Field | Purpose |
| --- | --- |
| `original_clock_in` | First recorded clock-in. It is captured automatically and cannot be changed later. |
| `original_clock_out` | First recorded clock-out. It is captured automatically and cannot be changed later. |
| `pre_shift_overtime_minutes` | Credited minutes before the scheduled shift start. |
| `regular_minutes` | Worked minutes overlapping the scheduled shift. |
| `post_shift_overtime_minutes` | Credited minutes after the scheduled shift end. |
| `total_overtime_minutes` | Total credited overtime. Kept synchronized with the existing `overtime_minutes` field. |
| `total_worked_minutes` | Whole elapsed minutes between effective `clock_in` and `clock_out`. |
| `is_corrected` | Indicates that effective timestamps differ from originals or correction metadata exists. |
| `review_status` | `pending`, `approved`, `corrected`, `rejected`, or `locked`. |
| `reviewed_by` | Workforce user responsible for the latest review. |
| `reviewed_at` | Timestamp of the latest review. |

The existing `clock_in` and `clock_out` columns remain the effective values consumed by reports and future payroll logic.

## Compatibility behavior

The migration adds a `BEFORE INSERT OR UPDATE` attendance trigger that:

1. Captures the first clock-in and clock-out in the original timestamp fields.
2. Prevents later modification of a captured original timestamp.
3. Keeps `overtime_minutes` and `total_overtime_minutes` synchronized in both directions.
4. Calculates `total_worked_minutes` from the effective timestamps.
5. Sets `is_corrected` when effective timestamps differ from captured originals or correction metadata exists.
6. Rejects a clock-out earlier than clock-in.

This lets the existing Step 7 RPC functions continue working until Step 9 replaces their inline calculations with the trusted structured calculation function.

## Historical records

The migration does not invent pre-shift, regular, or post-shift component values for old records when those components were not previously stored.

For existing records:

- `total_overtime_minutes` is copied from the existing `overtime_minutes` value.
- `total_worked_minutes` is derived from effective clock-in and clock-out.
- Original timestamps are copied only when no prior correction metadata exists.
- Records that appear to have been corrected before this migration retain `NULL` original timestamps because the previous values cannot be reconstructed safely.
- Structured component fields remain `NULL` until Step 9 performs a trusted recalculation.
- Review status starts as `pending`.

No attendance record should be considered payroll-ready solely because this migration was applied.

## Database enforcement

The migration adds validated constraints for:

- Nonnegative structured minute values.
- Allowed review statuses.
- Paired `reviewed_by` and `reviewed_at` values.
- Valid original clock ordering.
- Equality between `overtime_minutes` and `total_overtime_minutes` during the compatibility period.

It also adds indexes supporting review-status, corrected-record, and reviewer/date filters.

## Verification

Run:

`supabase/verification/attendance_review_storage_check.sql`

The verification script checks:

- All 11 fields.
- All five constraints and their validation state.
- The storage trigger and function.
- Supporting indexes.
- Overtime compatibility.
- Worked-minute accuracy.
- Review metadata consistency.
- Invalid review statuses or negative durations.
- Records still awaiting Step 9 structured recalculation.
- The migration audit marker.

## Automated test

`tests/attendance-review-storage.test.mjs`

The repository test confirms that the migration contains every required field, review status, constraint, immutability safeguard, compatibility rule, historical-data policy, and verification artifact.

## Deployment order

1. Back up the internal test database.
2. Check for existing attendance records with invalid clock order or negative legacy minute values.
3. Apply `2026070807_attendance_review_storage.sql`.
4. Run `attendance_review_storage_check.sql`.
5. Run the repository test suite.
6. Confirm the existing attendance page can still clock in and clock out.
7. Confirm `original_clock_in` and `original_clock_out` populate once and remain unchanged.
8. Proceed to Step 9 only after verification passes.

## Step 9 boundary

Step 8 establishes storage and integrity rules. Step 9 must still add the trusted server-side calculation function that populates:

- `pre_shift_overtime_minutes`
- `regular_minutes`
- `post_shift_overtime_minutes`
- `total_overtime_minutes`
- `total_worked_minutes`
- `minutes_late`
- `undertime_minutes`

Step 9 must also enforce the 20-hour overtime limit across all attendance records assigned to the same employee and scheduled work date.
