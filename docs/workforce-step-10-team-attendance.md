# Phase 1, Step 10 — Team Attendance

## Status

Implemented on the `phase1-step10-team-attendance` branch. Apply the migration and run the verification script in the internal Supabase environment before marking Step 10 complete.

## Page

`team-attendance.html`

The page is a read-only attendance review interface for users with the `view_team_attendance` permission.

It displays:

- Employee
- Team
- Work date
- Assigned shift
- Effective clock-in and clock-out
- Regular minutes
- Pre-shift overtime
- Post-shift overtime
- Total overtime
- Late minutes
- Undertime
- Attendance status
- Correction and review status
- Last correcting user and correction date

The page also summarizes the currently filtered record count, open sessions, missing clock-outs, and overtime records.

## Filters

The page supports:

- Start and end date, limited to 367 inclusive calendar days
- Employee
- Team
- Attendance status
- Corrected or uncorrected records
- Open attendance records
- Missing clock-out records
- Overtime records

Open attendance means a clock-in exists without a clock-out. A record is marked as missing a clock-out when it remains open after the linked shift ended, or when an unscheduled/open record belongs to a past local work date.

## Security and scope

`supabase/migrations-legacy/2026070902_team_attendance_page.sql` adds:

`workforce_list_team_attendance(start_date, end_date)`

The function:

- Requires an authenticated, active workforce profile.
- Requires `view_team_attendance`.
- Uses `workforce_can_manage_user` for every returned employee.
- Allows administrators to see their authorized organization scope.
- Limits supervisors to employees assigned through their direct or team-supervisor scope.
- Exposes no insert, update, correction, or approval action.
- Is not executable by `anon`.

The existing attendance RLS policies remain in force for the supporting employee and team filter queries.

## Step boundary

Step 10 is intentionally read-only.

The following remain for Steps 11 and 12:

- `correct_attendance`
- `approve_attendance`
- Correction controls
- Approval controls
- Mandatory correction reasons
- Structured correction-history writes

`manage_payroll` does not grant access to this page unless `view_team_attendance` is also granted.

## Files

- `team-attendance.html`
- `scripts/team-attendance.js`
- `styles/team-attendance.css`
- `supabase/migrations-legacy/2026070902_team_attendance_page.sql`
- `supabase/verification/team_attendance_page_check.sql`
- `tests/team-attendance-page.test.mjs`

## Deployment

1. Confirm Step 9 migration `2026070901_attendance_structured_calculation.sql` is applied.
2. Apply `2026070902_team_attendance_page.sql`.
3. Run `supabase/verification/team_attendance_page_check.sql`.
4. Confirm every blocker query in section 5 returns zero rows.
5. Run `npm test`.
6. Test with an authorized administrator.
7. Test with a supervisor and confirm only assigned employees appear.
8. Test a user without `view_team_attendance` and confirm access is denied.
9. Test date, employee, team, status, corrected, open, missing clock-out, and overtime filters.
