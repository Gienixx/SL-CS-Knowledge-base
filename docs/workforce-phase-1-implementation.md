# Phase 1 Workforce Foundation Implementation

## Purpose

Add workforce profiles, permissions, teams, schedules, attendance, leave management, and audit logging without breaking the current login, dashboard, user-management, reporting, or article-editor features.

## Compatibility rules

1. Keep `public.login` as the current compatibility source for `is_admin` and `can_edit_articles` until all existing pages and Cloudflare Functions use the workforce permission service.
2. Add new tables and functions through additive migrations only.
3. Do not rename or remove existing login columns during Phase 1.
4. Do not expose workforce administration solely through client-side checks. Database RLS and server-side authorization remain authoritative.
5. Do not deploy payroll tables, salary fields, or payslip storage during Phase 1.
6. Release workforce features behind page-level permission checks and test them in an internal environment before production.

## Implementation steps

### Step 1 — Database and compatibility foundation

Deliverables:

- Create `teams`, `profiles`, `user_permissions`, `work_schedules`, `attendance`, `leave_requests`, and `workforce_audit_logs`.
- Backfill profiles from Supabase Auth and `public.login`.
- Preserve existing `is_admin` and `can_edit_articles` behavior.
- Add helper functions for current-user permission and supervisor checks.
- Enable RLS on every workforce table.
- Add indexes, constraints, updated-at triggers, and administrative audit triggers.
- Add secure RPC functions for agent clock-in and clock-out.

Acceptance gate:

- Migration runs successfully on a clean test database and an existing database.
- Existing users can still sign in.
- Existing admin and article-editor checks still return the same result.
- No workforce table is readable by anonymous users.

### Step 2 — Central permission service

Deliverables:

- Add a shared browser module for loading the current profile and effective permissions.
- Add a shared Cloudflare Function authorization helper.
- Map the existing access types:
  - Admin and Agent: agent profile with workforce-management permissions.
  - Admin: admin profile with global workforce permissions.
  - Agent with Article Editor access: agent profile with `edit_articles`.
  - Regular Agent: agent profile without elevated permissions.
- Keep `public.login` synchronized while old pages still depend on it.

Acceptance gate:

- Dashboard, user management, and article management behave exactly as before.
- Permission checks return the same result in the browser, Cloudflare Functions, and RLS.
- A user cannot gain access by editing browser state or calling an endpoint directly.

### Step 3 — Employee and team administration

Pages:

- `workforce.html`
- `team-management.html`

Deliverables:

- Employee list and profile editor.
- Team creation and assignment.
- Supervisor assignment.
- Employment-status management.
- Permission assignment for workforce, article editing, and future payroll access.
- Audit entries for profile, team, supervisor, and permission changes.

Acceptance gate:

- Only users with `manage_employees` can create or modify employee records.
- Supervisors can view only assigned team members.
- Regular agents can view only their own profile.

### Step 4 — Schedule management

Pages:

- `my-schedule.html`
- Schedule section in `workforce.html`

Deliverables:

- Weekly and monthly schedule views.
- Shift creation and editing.
- Rest-day and holiday marking.
- Schedule-change visibility for agents.
- Validation against invalid time ranges and duplicate shift sequence numbers.

Acceptance gate:

- Agents can view only their own shifts.
- Authorized supervisors can view assigned team shifts.
- Only users with `manage_schedules` can create or edit shifts.

### Step 5 — Attendance

Page:

- `attendance.html`

Deliverables:

- Secure clock-in and clock-out actions through database RPC functions.
- Agent attendance history.
- Team attendance view for authorized users.
- Corrections, notes, status, overtime, and undertime management.
- Audit trail for every administrative attendance change.

Acceptance gate:

- An agent cannot clock in or out for another employee.
- An agent cannot directly set overtime, undertime, correction notes, or approval fields.
- Corrections retain before-and-after values in the audit log.

### Step 6 — Leave management

Page:

- `leave-requests.html`

Deliverables:

- Agent leave-request submission and status tracking.
- Leave type, inclusive date range, and reason.
- Approval and rejection workflow with reviewer notes.
- Leave-history view.

Acceptance gate:

- Agents can submit and view only their own requests.
- Only users with `approve_leave` can review requests.
- Supervisors can review only requests from assigned team members unless they are administrators.

### Step 7 — Existing-page integration

Deliverables:

- Add workforce navigation based on effective permissions.
- Add employee creation/update hooks to the current user-management workflow.
- Preserve existing first-login password change, reporting dashboard, and article-editor behavior.
- Add mobile-responsive navigation and empty/error/loading states.

Acceptance gate:

- Existing login, dashboard, reporting, user management, password, knowledge-base, and article features pass regression tests.

### Step 8 — Security and automated tests

Deliverables:

- RLS verification SQL.
- Permission matrix tests for all supported user types.
- Endpoint authorization tests.
- Attendance and leave workflow tests.
- Audit-log tests.
- Repository integrity tests for required pages and scripts.

Required test identities:

1. Admin and Agent.
2. Admin only.
3. Agent with Article Editor access.
4. Regular Agent.
5. Supervisor with team-scoped permissions.

Acceptance gate:

- No test identity can read or modify records outside its allowed scope.
- Anonymous requests receive no workforce data.

### Step 9 — Team assignment and internal cycle

Deliverables:

- Assign profiles, teams, supervisors, and permissions for all 11 users.
- Run one complete schedule, attendance, correction, leave-submission, and leave-review cycle.
- Record issues and correct them before production.

Acceptance gate:

- All 11 users have verified access.
- Attendance corrections are logged.
- Leave requests complete the full workflow.

### Step 10 — Production release

Deliverables:

- Apply the tested migration.
- Deploy pages, scripts, and Cloudflare Functions.
- Verify RLS and permissions in production.
- Monitor authentication, permission-denied errors, and audit logs.

Rollback boundary:

- Workforce pages can be removed from navigation without affecting existing features.
- New workforce tables are additive and must not be dropped during rollback.
- Existing `public.login` behavior remains available until a later migration explicitly retires it.

## Development order

1. Database migration and verification SQL.
2. Permission service and compatibility synchronization.
3. Employee/team administration.
4. Schedule management.
5. Attendance.
6. Leave management.
7. Regression and permission tests.
8. Internal cycle and production release.

## Definition of Phase 1 complete

- All 11 users have the correct profile, role, team, supervisor, and permissions.
- Agents can view only their own workforce records.
- Authorized supervisors are limited to assigned team members.
- Authorized administrators can manage schedules, attendance, and leave.
- Attendance corrections and administrative changes are audited.
- Existing login, dashboard, reporting, password, knowledge-base, and article features continue working.
