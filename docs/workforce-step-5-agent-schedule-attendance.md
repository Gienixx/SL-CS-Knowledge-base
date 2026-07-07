# Workforce Phase 1 — Step 5 Agent Schedule and Attendance

## Scope

Step 5 completes the agent-facing workforce experience:

- Agents can open `my-schedule.html` to review released shifts, rest days, holidays, and schedule changes.
- Agents can open `attendance.html` to clock in, clock out, review the active shift, and view monthly attendance history.
- Admin-only profiles cannot use self-service clock actions unless they also participate as agents.
- Admin-and-agent profiles retain access to Workforce Management from the attendance and schedule pages.

## Files

- `attendance.html`
- `scripts/attendance.js`
- `styles/attendance.css`
- `supabase/migrations/2026070801_agent_attendance_interface.sql`
- `supabase/verification/agent_attendance_check.sql`
- `tests/agent-attendance-interface.test.mjs`

The Home sidebar and My Schedule page are also updated with Attendance navigation.

## Attendance behavior

### Clock in

The agent selects a released shift when one or more shifts are assigned for the current local date. The clock-in record is linked to the selected schedule. When no released shift exists, the system permits an unscheduled clock-in. Clock-in is disabled when the only released entry is a rest day.

The database function:

- resolves the agent’s canonical or explicitly linked workforce profile;
- rejects schedules that do not belong to the current identity;
- rejects rest-day, draft, cancelled, and completed schedule entries;
- prevents a second clock-in for the same local work date;
- calculates initial late minutes from the assigned shift start.

### Clock out

The database function finds the current identity’s open attendance record for the local work date, records the clock-out time, and calculates initial overtime or undertime from the linked schedule end.

Administrators can correct these values in the later attendance-management step. Existing attendance audit triggers record both self-service and administrative changes.

## Identity-link compatibility

Some legacy Auth accounts are explicitly linked to workforce profiles with different UUIDs. Step 5 does not rely on `auth.uid()` as the attendance owner. The migration adds `workforce_current_profile_id()` and updates both clock functions to use `workforce_is_current_identity(...)`.

The UI queries all profile IDs returned by `workforce_get_current_access()`, so schedules and attendance history remain visible for explicitly linked legacy profiles.

## Deployment order

1. Apply `supabase/migrations/2026070801_agent_attendance_interface.sql` in the internal Supabase environment.
2. Run `supabase/verification/agent_attendance_check.sql`.
3. Deploy the site files to the internal Cloudflare Pages environment.
4. Test with a Regular Agent account.
5. Test with an Agent with Article Editor access account.
6. Test with an Admin and Agent account.
7. Confirm an Admin-only account is denied attendance clock access.
8. Test a released shift, changed shift, rest day, unscheduled day, duplicate clock-in, and clock-out.
9. Review the resulting rows in `attendance` and `workforce_audit_logs`.

## Step 5 acceptance checks

- Agents can view only schedules and attendance records within their permitted identity scope.
- Draft schedules remain hidden from agents.
- Changed schedules are clearly identified.
- Clock-in and clock-out use the employee’s configured timezone.
- Duplicate same-day clock-in is rejected.
- Attendance history shows status, worked time, late minutes, overtime, undertime, and administrative notes.
- Current Home, dashboard, Knowledge Base, article, and workforce-admin navigation remains intact.
