# Rest-Day and Holiday Overtime Attendance

## Rule

Agents may clock in on released rest-day and holiday schedules.

Attendance classification is:

- Rest day: all credited worked minutes are `rest_day_overtime_minutes` and are displayed as RDOT.
- Holiday that is not a rest day: all credited worked minutes are `holiday_overtime_minutes` and are included in normal total overtime.
- Rest day and holiday combined: RDOT takes precedence. The same minute is not counted as both RDOT and holiday overtime.

All special-day minutes are included in `total_overtime_minutes` and remain subject to the maximum 1,200 credited overtime minutes per employee and work date.

## Clock-in availability

A published or changed rest-day or holiday schedule becomes selectable on the Attendance page.

For special work dates without shift times, clock-in is available during the employee's local scheduled date.

For an overnight special-day schedule with a configured end time, clock-in remains available after midnight while the prior work-date schedule is still active.

Only one attendance session may remain open at a time.

## Calculation behavior

### Rest day

For completed rest-day attendance:

```text
regular_minutes = 0
pre_shift_overtime_minutes = 0
post_shift_overtime_minutes = 0
rest_day_overtime_minutes = credited worked minutes
holiday_overtime_minutes = 0
total_overtime_minutes = rest_day_overtime_minutes
```

### Holiday

For completed holiday-only attendance:

```text
regular_minutes = 0
pre_shift_overtime_minutes = 0
post_shift_overtime_minutes = 0
rest_day_overtime_minutes = 0
holiday_overtime_minutes = credited worked minutes
total_overtime_minutes = holiday_overtime_minutes
```

Holiday minutes appear to agents as OT rather than RDOT.

### Open sessions

Special-day overtime remains zero while the session is open because the final credited duration is not known until clock-out. The page still displays live elapsed worked time.

## Overtime cap

The calculator first subtracts overtime already credited to other attendance records on the same employee work date.

Only the remaining allowance may be credited to the rest-day or holiday record. This preserves the aggregate 20-hour limit across multiple shifts and attendance records.

## Agent interface

The Attendance page now:

- Includes rest days and holidays in the schedule selector.
- Explains whether the selected work date will count as RDOT or OT.
- Enables clock-in on the eligible special work date.
- Displays `RDOT` separately in attendance history.
- Displays holiday overtime under the normal `OT` badge.

## Database changes

Migration:

```text
supabase/migrations/2026070906_rest_day_holiday_overtime.sql
```

New attendance columns:

```text
rest_day_overtime_minutes
holiday_overtime_minutes
```

The trusted calculation function now accepts rest-day and holiday flags. The original seven-argument calculation contract remains available as a compatibility wrapper for normal attendance calculations.

## Deployment

Do not apply the migration while an employee attendance session is actively being tested or while workforce pages are issuing database requests.

Apply:

```text
supabase/migrations/2026070906_rest_day_holiday_overtime.sql
```

Then run:

```text
supabase/verification/rest_day_holiday_overtime_check.sql
```

Every blocker query in section 5 must return zero rows.

## Manual validation

Test at least:

1. A published rest day without shift times appears in Attendance.
2. The agent can clock in on the rest day.
3. The agent can clock out normally.
4. All credited minutes appear as RDOT.
5. A holiday-only schedule appears in Attendance.
6. The agent can clock in and out on the holiday.
7. All credited minutes appear as OT and not RDOT.
8. A date marked as both rest day and holiday becomes RDOT only.
9. A future rest day or holiday cannot be clocked into before its local date.
10. A completed special-day record cannot be clocked into twice.
11. A second open attendance session is rejected.
12. Multiple records on the same work date remain within the 20-hour overtime cap.
