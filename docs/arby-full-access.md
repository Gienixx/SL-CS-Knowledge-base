# Arby Full-Access Policy

## Identity

The Arby workforce profile represents the project owner account for this application. Repository migrations resolve the account through the approved Arby profile and login aliases without committing an email address or Auth UUID.

The migration aborts unless exactly one existing profile resolves to Arby.

## Visible role

Arby remains displayed as a **Regular Agent**:

- `base_role = agent`
- `is_agent = true`
- existing team and supervisor assignments are preserved

The visible role is separate from authorization scope.

## Effective access

Arby receives hidden site-owner capability through:

- `is_system_admin = true`
- compatibility `login.is_admin = true`
- active employment status
- article-editor capability
- payroll-management capability

Every current workforce permission is explicitly granted:

- `manage_employees`
- `manage_schedules`
- `view_team_attendance`
- `approve_leave`
- `view_workforce_reports`
- `edit_articles`
- `manage_payroll`

This provides access to employee and user management, schedule administration, team attendance, leave approval, reporting operations, article management, payroll administration, and agent self-service features.

## Deployment

1. Confirm workforce migrations through `2026070703_workforce_schedule_management.sql` are already applied.
2. Apply `supabase/migrations/2026070704_arby_full_access.sql`.
3. Run `supabase/verification/arby_full_access_check.sql`.
4. Confirm the identity, profile, permission, and login blocker queries return zero rows.
5. Confirm the granted permission count is exactly `7`.
6. Sign out and sign back in as Arby so refreshed access data is loaded by the browser.
7. Confirm all permission-aware navigation is available, including My Schedule, Workforce Management, Reporting Operations, Article Management, User Management, and payroll administration.

## Maintenance rule

Future permission keys must be added to both the Arby full-access migration policy and its verification query. The hidden system-admin flag provides administrator scope, but explicit permission rows remain required so capability-aware pages and server functions report the correct access state.
