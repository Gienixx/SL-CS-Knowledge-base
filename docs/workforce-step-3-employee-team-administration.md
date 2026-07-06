# Workforce Phase 1 Step 3 — Employee and Team Administration

## Delivered scope

- `workforce.html` for employee profile, role, status, team, supervisor, timezone, and permission management.
- `team-management.html` for team creation, supervisor assignment, activation, and editing.
- Dashboard navigation visible only to active administrators with `manage_employees`.
- Transactional employee administration through `workforce_admin_save_employee`.
- Transactional team administration through `workforce_admin_save_team`.
- Existing profile, team, and permission audit triggers remain active.
- Existing `public.login.is_admin` and `public.login.can_edit_articles` fields remain synchronized.

## Supported access types

| Access type | Base role | Agent workflows | Article editor default |
| --- | --- | --- | --- |
| Admin and Agent | Admin | Enabled | Configurable |
| Admin | Admin | Disabled | Configurable |
| Agent with Article Editor access | Agent | Enabled | Enabled |
| Regular Agent | Agent | Enabled | Disabled |

Workforce and payroll permissions remain individually grantable. Administrator status controls global scope but does not silently replace the explicit permission records saved by the Step 3 RPC.

## Security controls

- Both pages require an authenticated workforce profile.
- Both pages require `manage_employees` and administrator scope.
- Database RLS remains authoritative for all table reads.
- RPCs repeat the administrator and permission checks inside PostgreSQL.
- Employee profile, permissions, and legacy compatibility fields are updated within one database transaction.
- The current operator cannot remove their own active administrator and `manage_employees` access.
- Anonymous users cannot execute either administration RPC.
- Administrative changes continue to write to `workforce_audit_logs` through existing triggers.

## Deployment order

1. Apply migrations through `2026070606_workforce_employee_team_admin.sql` in the internal Supabase environment.
2. Run `supabase/verification/workforce_employee_team_admin_check.sql`.
3. Deploy the new pages, scripts, stylesheet, and dashboard navigation update.
4. Test one identity for each supported access type.
5. Create the initial teams and assign supervisors.
6. Update the five existing active users, then add and configure the remaining six users through User Management and Workforce Management.

## Current known role matrix

- Almar — Admin and Agent
- Arby — Admin and Agent
- Arez — Agent with Article Editor access
- Gen — Agent with Article Editor access
- Jean — Regular Agent

The remaining six users are intentionally not seeded by the migration because their approved email addresses, employee IDs, teams, supervisors, and access assignments are not yet present in the current rollout data.
