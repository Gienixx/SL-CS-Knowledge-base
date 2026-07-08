# Attendance timing and overtime policy

## Implemented behavior

- Agents may clock in at any time before an eligible released `published` or `changed` shift shown in the attendance date range.
- The former 15-minute early clock-in restriction has been removed from both the browser client and the database RPC.
- All completed minutes before the scheduled start are treated as pre-shift overtime. The first 15 minutes are included normally and receive no special handling.
- Completed minutes after the scheduled end are treated as post-shift overtime.
- Credited pre-shift and post-shift overtime is capped at 1,200 minutes per employee per scheduled work date, aggregated across all attendance records assigned to that work date.
- Clock-out remains available even when actual overtime exceeds the limit. Excess time is not added to the credited combined overtime value.
- Active overnight shifts remain available after midnight and retain their original scheduled work date.
- Multiple scheduled shifts on the same work date receive separate attendance records.
- Only one attendance record may remain clocked in at a time. Attendance actions are serialized server-side to protect against parallel requests.
- A shift is no longer available for clock-in after its scheduled end.
- Agents with a relevant released shift cannot bypass schedule selection by submitting an unscheduled clock-in request.
- Late and undertime calculations continue to use the selected published or changed schedule.
- Rest days and unreleased schedules remain unavailable for clock-in.
- Unscheduled attendance remains available only when no relevant released shift is assigned.

The current `overtime_minutes` field continues to hold the credited combined overtime value during Step 7. Separate `pre_shift_overtime_minutes`, `post_shift_overtime_minutes`, `regular_minutes`, `total_overtime_minutes`, and `total_worked_minutes` fields are added in Step 8 and populated through the structured calculation work in Step 9.

## Deployment

Apply the migrations after the existing workforce migrations through `2026070802_workforce_timezone_new_york.sql`, in this order:

```sql
supabase/migrations/2026070803_attendance_early_clock_in_overtime.sql
supabase/migrations/2026070804_attendance_released_schedule_enforcement.sql
supabase/migrations/2026070805_attendance_overnight_multi_shift.sql
supabase/migrations/2026070806_attendance_unrestricted_pre_shift_overtime_cap.sql
```

Then run:

```sql
supabase/verification/attendance_early_clock_in_overtime_check.sql
```

The blocker queries must return zero rows. All function-definition and index checks must return `true`, the overtime aggregate query must return zero rows, and all four attendance rollout audit entries must be present.

## Required manual tests

1. Select a published shift several hours before its scheduled start. Clock-in must succeed.
2. Confirm the resulting attendance record retains the schedule's `shift_date` as its `work_date`.
3. Attempt the same request without a schedule ID. It must be rejected when a relevant released shift exists.
4. Clock in 10 minutes early and clock out at the scheduled end. Attendance must show 10 credited overtime minutes.
5. Clock in several hours early and clock out after the scheduled end. The combined credited overtime must equal pre-shift plus post-shift overtime until the work-date cap is reached.
6. Create multiple non-overlapping shifts on one work date. Their combined credited overtime must not exceed 1,200 minutes.
7. Exceed the 1,200-minute overtime limit and clock out. Clock-out must succeed, while credited work-date overtime remains capped.
8. Clock in after the scheduled start but before the scheduled end. Late minutes must be recorded and pre-shift overtime must remain zero.
9. Open Attendance after midnight during a shift that began on the previous date. The active overnight shift must appear and allow clock-in.
10. Attempt to clock in to a second shift while another attendance record is still open. The request must be rejected.
11. Submit two parallel clock-in requests. At most one open attendance record may be created.
12. Attempt clock-in after the selected shift has ended. The request must be rejected.
13. Attempt clock-in against a draft, cancelled, completed, or rest-day schedule. The request must be rejected.
14. With no relevant released shift assigned, confirm that unscheduled attendance remains available.

## Regression test

Run:

```bash
npm test
```

The repository test `tests/attendance-early-clock-in-overtime.test.mjs` verifies the unrestricted client window, server-side overtime cap, overnight date range, multi-shift uniqueness model, serialized clock-in protection, and continued shift-end enforcement.
