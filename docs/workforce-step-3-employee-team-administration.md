# Workforce Phase 1 Step 3 — Employee and Team Administration

## Delivered scope

- `workforce.html` for employee profile, role, status, team, supervisor, timezone, and permission management.
- `team-management.html` for team creation, supervisor assignment, activation, and editing.
- Dashboard navigation visible only to effective administrators with `manage_employees`.
- Transactional employee administration through `workforce_admin_save_employee`.
- Transactional team administration through `workforce_admin_save_team`.
- Existing profile, team, and permission audit triggers remain active.
- Existing `public.login.is_admin` and `public.login.can_edit_articles` fields remain synchronized.
- A hidden `profiles.is_system_admin` capability for the site owner without exposing a selectable System Administrator role in the workforce interface.

## Supported visible access types

| Access type | Base role | Agent workflows | Article editor default |
| --- | --- | --- | --- |
| Admin and Agent | Admin | Enabled | Configurable |
| Admin | Admin | Disabled | Configurable |
| Agent with Article Editor access | Agent | Enabled | Enabled |
| Regular Agent | Agent | Enabled | Disabled |

Workforce and payroll permissions remain individually grantable. Administrator status controls global scope but does not silently replace explicit permission records.

The hidden System Administrator capability is not a visible access type. A system administrator remains `base_role = 'agent'`, appears as a Regular Agent in Workforce Management, and receives effective administrator scope plus all explicit permissions. The flag can only be changed through a reviewed migration or service-role database operation, not through the normal employee editor.

## Security controls

- Both pages require an authenticated workforce profile.
- Both pages require `manage_employees` and effective administrator scope.
- Database RLS remains authoritative for all table reads.
- RPCs repeat administrator and permission checks inside PostgreSQL.
- Employee profile, permissions, and compatibility fields are updated within one database transaction.
- The current operator cannot remove their own active administrator or system-administrator access.
- Anonymous users cannot execute either administration RPC.
- Administrative changes continue to write to `workforce_audit_logs` through existing triggers.
- The normal employee editor cannot remove the hidden site-owner flag or revoke the site owner's required permissions.

## Internal test roster

Only five real users are currently assigned for Workforce Phase 1 testing. The existing dummy account is retained and is not modified by the roster migration.

| User | Visible access type | Team | Supervisor | Article editor | Hidden system administrator |
| --- | --- | --- | --- | --- | --- |
| Almar | Admin and Agent | Unassigned | None | No | No |
| Arby | Regular Agent | Support Team | Almar | Yes through system access | Yes |
| Arez | Agent with Article Editor access | Cashout Team | Almar | Yes | No |
| Gen | Agent with Article Editor access | Support Team | Almar | Yes | No |
| Jean | Regular Agent | Support Team | Almar | No | No |

Arby is the site owner and maintenance administrator. His workforce-facing role remains Regular Agent, while `is_system_admin = true` gives him effective access to all site features, including employee management, schedules, attendance, leave approvals, workforce reports, articles, and future payroll controls.

The other six organizational-chart members are not added or assigned yet. They will be created only after the workforce features pass internal testing.

## Supabase deployment order

1. Apply migrations through `2026070607_reporting_operations_admin_access.sql` in the internal Supabase environment.
2. Apply `2026070701_workforce_initial_roster_assignments.sql`.
3. Run `supabase/verification/workforce_initial_roster_assignments_check.sql`.
4. Confirm the blocker queries return zero rows.
5. Confirm the five-row test matrix is correct and the dummy account appears only in the outside-test-roster listing.
6. Deploy the updated frontend files.
7. Test Almar, Arby, Arez, Gen, Jean, and the dummy account.

## Step 3 completion boundary

Repository implementation is complete when the migration, verification SQL, pages, scripts, and tests are present. Deployment is complete only after the SQL has run successfully in Supabase and all five test identities have been manually verified.
