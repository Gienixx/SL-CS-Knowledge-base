# Workforce Phase 1 Step 4 — Schedule Management

## Delivered scope

### Administrator schedule controls

- An administrator-only Schedule Management section inside `workforce.html`.
- Weekly and monthly ranges with previous, current, and next navigation.
- Team, employee, and status filters.
- Shift creation and editing for active agent-enabled profiles.
- Rest-day and holiday marking.
- Schedule statuses: Scheduled, Published, Changed, Cancelled, and Completed.
- Published schedule edits automatically become Changed when shift-defining fields are modified.
- Secure transactional writes through `workforce_admin_save_schedule`.

### Agent and supervisor schedule access

- `my-schedule.html` for active agents and authorized schedule managers.
- Weekly and monthly calendar views plus a detailed schedule table.
- Regular agents query only their own Published, Changed, Cancelled, and Completed entries.
- Changed schedules are highlighted and include the last-updated timestamp and full details.
- Users with `manage_schedules` receive a Team schedule scope only when RLS exposes supervised or otherwise authorized employee profiles.
- Team scope can be filtered by employee and status.
- Dashboard navigation shows My Schedule only to agents or authorized schedule managers.

## Security boundary

- The administrator section is shown only to effective administrators with `manage_schedules`.
- The schedule-write RPC repeats authentication, active-profile, permission, target-scope, and agent-access checks.
- Team assignment is derived from the employee profile rather than trusted from the browser.
- Anonymous and default PUBLIC execution of the write RPC are explicitly revoked.
- `my-schedule.html` performs no privileged writes.
- Direct profile and schedule reads remain controlled by existing Row-Level Security policies.
- Regular agents explicitly filter the browser query to their own user ID, while RLS remains the authoritative protection.
- Supervisor and administrator team results are limited to profiles and schedules permitted by `workforce_can_manage_user` and `workforce_can_view_user`.

## Validation

- Shift sequence must be between 1 and 99 and unique per employee and shift date.
- Rest days cannot contain shift times.
- Normal shifts require valid start and end times, with the end later than the start.
- Shift start must fall on the selected shift date in the configured IANA timezone.
- Holidays require a holiday name.
- Schedules cannot be assigned to admin-only, inactive, or terminated profiles.
- Draft Scheduled entries are not shown in an agent's personal schedule view.
- Changed entries remain visible until an administrator moves them to another valid status.

## Deployment verification

1. Apply `supabase/migrations-legacy/2026070703_workforce_schedule_management.sql` in the target Supabase environment.
2. Run `supabase/verification/workforce_schedule_management_check.sql`.
3. Confirm all boolean checks return `true` and the blocker query returns zero rows.
4. Deploy the workforce and My Schedule frontend files.
5. Test create, edit, rest-day, holiday, overnight shift, duplicate-sequence, and published-change scenarios using an authorized administrator.
6. Test a Regular Agent and confirm only their own published records appear.
7. Test a supervisor with `manage_schedules` and confirm Team schedule contains only assigned or RLS-authorized employees.
8. Confirm an edited published shift appears as Changed on `my-schedule.html` with the new time and last-updated timestamp.

## Step 4 completion boundary

Step 4 is complete when administrator schedule creation and editing works, agents can view only their own released schedules, authorized supervisors can view assigned team schedules, and changed entries are visible to affected agents. Attendance and leave workflows remain separate steps.
