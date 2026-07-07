# Workforce Phase 1 Step 4 — Schedule Management

## Delivered scope

- An administrator-only Schedule Management section inside `workforce.html`.
- Weekly and monthly ranges with previous, current, and next navigation.
- Team, employee, and status filters.
- Shift creation and editing for active agent-enabled profiles.
- Rest-day and holiday marking.
- Schedule statuses: Scheduled, Published, Changed, Cancelled, and Completed.
- Published schedule edits automatically become Changed when shift-defining fields are modified.
- Secure transactional writes through `workforce_admin_save_schedule`.
- Existing `work_schedules` RLS and audit triggers remain authoritative.

## Security boundary

- The frontend section is shown only to effective administrators with `manage_schedules`.
- The database RPC repeats authentication, active-profile, permission, target-scope, and agent-access checks.
- Team assignment is derived from the employee profile rather than trusted from the browser.
- Anonymous execution is explicitly revoked.
- Direct table access remains controlled by existing Row-Level Security policies.

## Validation

- Shift sequence must be between 1 and 99 and unique per employee and shift date.
- Rest days cannot contain shift times.
- Normal shifts require valid start and end times, with the end later than the start.
- Shift start must fall on the selected shift date in the configured IANA timezone.
- Holidays require a holiday name.
- Schedules cannot be assigned to admin-only, inactive, or terminated profiles.

## Deployment order

1. Apply `supabase/migrations/2026070703_workforce_schedule_management.sql` in the internal Supabase environment.
2. Run `supabase/verification/workforce_schedule_management_check.sql`.
3. Confirm all boolean checks return `true` and the blocker query returns zero rows.
4. Deploy the updated workforce HTML, stylesheet, and schedule script.
5. Test create, edit, rest-day, holiday, overnight shift, duplicate-sequence, and published-change scenarios using an authorized administrator.

## Step boundary

This step implements administrator schedule management only. Agent self-service schedule display, attendance clock actions, attendance corrections, and leave workflows remain separate deployment steps.
