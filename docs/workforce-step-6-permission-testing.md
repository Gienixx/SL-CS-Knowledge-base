# Workforce Deployment Step 6 — Permission Testing

## Objective

Verify every supported workforce user type before the limited internal deployment. Browser visibility is not treated as a security boundary: each test must also confirm the database, RPC, and Cloudflare Function authorization result.

This deployment step corresponds to **"Test permissions using each user type"** in the Workforce Management deployment sequence.

## Required test identities

Use one active internal account for each scope:

1. **Admin and Agent**
   - `base_role = 'admin'`
   - `is_agent = true`
   - Explicit workforce administration grants
2. **Admin only**
   - `base_role = 'admin'`
   - `is_agent = false`
   - Explicit workforce administration grants
3. **Agent with Article Editor access**
   - `base_role = 'agent'`
   - `is_agent = true`
   - `edit_articles = true`
   - No workforce administration grants
4. **Regular Agent**
   - `base_role = 'agent'`
   - `is_agent = true`
   - No elevated grants
5. **Team-scoped Supervisor**
   - `base_role = 'agent'`
   - `is_agent = true`
   - Assigned as a profile or team supervisor
   - `manage_schedules`, `view_team_attendance`, and `approve_leave` granted
   - `manage_employees` not granted
6. **Anonymous session**
   - Signed out browser or request without a bearer token

The supervisor account needs at least one assigned employee and at least one employee outside its scope. Otherwise the negative cross-team test is not meaningful.

## Automated repository tests

Run:

```bash
npm run test:workforce-permissions
```

Then run the complete regression suite:

```bash
npm test
```

The permission test verifies:

- visible access-type mapping;
- explicit grants and explicit revocation;
- inactive-user denial;
- account-management endpoint enforcement;
- administrator scope plus `manage_employees` enforcement;
- admin-only denial from agent attendance workflows;
- workforce and team page guards;
- linked-identity schedule and attendance access;
- required RLS declarations;
- anonymous table and RPC denial artifacts;
- supervisor-scoping and identity-safe attendance helpers.

## Supabase verification

Apply all required workforce migrations through:

```text
supabase/migrations/2026070802_workforce_timezone_new_york.sql
```

Run:

```text
supabase/verification/workforce_permission_matrix_check.sql
```

Queries marked **BLOCKER: should return 0 rows** must be empty. The verification script:

- finds a representative account for every required user type;
- compares profile role fields with the expected access type;
- compares explicit `user_permissions` grants with the test matrix;
- impersonates each representative through JWT claims and checks `workforce_get_current_access()`;
- confirms the supervisor test has assigned and unrelated employees;
- confirms RLS is enabled on every workforce table;
- confirms `anon` has no workforce table or permission-RPC access;
- confirms authenticated execution of the access and attendance RPCs.

The script runs inside a transaction and ends with `rollback`.

## Browser and API test matrix

Record the result of every row as Pass or Fail. Use a private/incognito session between identities to prevent session crossover.

| Test | Admin and Agent | Admin only | Agent + Editor | Regular Agent | Supervisor | Anonymous |
|---|---|---|---|---|---|---|
| Sign in and load Home | Allow | Allow | Allow | Allow | Allow | Deny |
| Open Workforce employee administration | Allow | Allow | Deny | Deny | Deny | Deny |
| Open Team Management | Allow | Allow | Deny | Deny | Deny | Deny |
| Create or edit employee | Allow with `manage_employees` | Allow with `manage_employees` | Deny | Deny | Deny | Deny |
| Create or edit team | Allow with `manage_employees` | Allow with `manage_employees` | Deny | Deny | Deny | Deny |
| Open own schedule | Allow | Not available unless also an Agent | Allow | Allow | Allow | Deny |
| View another team's schedule | Allow when granted | Allow when granted | Deny | Deny | Deny | Deny |
| View assigned-team schedule | Allow when granted | Allow when granted | Deny | Deny | Allow | Deny |
| Create or edit assigned-team shift | Allow with `manage_schedules` | Allow with `manage_schedules` | Deny | Deny | Allow | Deny |
| Create or edit unrelated-team shift | Allow with `manage_schedules` | Allow with `manage_schedules` | Deny | Deny | Deny | Deny |
| Open Attendance | Allow | Deny | Allow | Allow | Allow | Deny |
| Clock in or out for self | Allow | Deny | Allow | Allow | Allow | Deny |
| Clock in or out for another employee | Deny | Deny | Deny | Deny | Deny | Deny |
| View own attendance history | Allow | Not available unless also an Agent | Allow | Allow | Allow | Deny |
| View assigned-team attendance | Allow when granted | Allow when granted | Deny | Deny | Allow | Deny |
| View unrelated-team attendance | Allow when granted as global admin | Allow when granted as global admin | Deny | Deny | Deny | Deny |
| Directly set overtime, undertime, correction notes, or reviewer fields | Deny through agent session | Administrative interface only | Deny | Deny | Only authorized correction/review workflow | Deny |
| Open article editor | Only with `edit_articles` | Only with `edit_articles` | Allow | Deny | Only with `edit_articles` | Deny |
| Call `/list-users` directly | Allow with admin + `manage_employees` | Allow with admin + `manage_employees` | Deny | Deny | Deny even if manually granted `manage_employees` without admin scope | Deny |
| Call `/create-user` directly | Allow with admin + `manage_employees` | Allow with admin + `manage_employees` | Deny | Deny | Deny | Deny |

## Required negative tests

### Browser-state tampering

For each denied identity:

1. Open Developer Tools.
2. Change or add local/session storage values that appear to grant a role.
3. Navigate directly to the protected page URL.
4. Call the protected Supabase table or RPC from the browser console.
5. Call `/list-users` or `/create-user` directly where applicable.

Expected result: the database or server returns a permission error. A visible button appearing because of client tampering must not grant data or write access.

### Explicit administrator revocation

Temporarily revoke one workforce permission from an internal Admin test identity, without changing `base_role = 'admin'`.

Expected result:

- the revoked action is denied;
- unrelated granted actions continue working;
- restoring the permission restores access;
- the change appears in `workforce_audit_logs`.

Do not perform the revocation on the only account capable of restoring permissions.

### Supervisor cross-team isolation

Using the team-scoped Supervisor:

1. View and modify an assigned employee's schedule.
2. View assigned-team attendance.
3. Attempt the same operations using an unrelated employee ID obtained by an administrator.
4. Attempt direct table and RPC calls for the unrelated employee.

Expected result: assigned-team operations succeed and unrelated-team operations return no row or a permission error.

### Agent identity isolation

Using each Agent identity:

1. View My Schedule and Attendance.
2. Confirm only canonical or explicitly linked profile IDs are returned.
3. Attempt to pass another employee's schedule ID to `workforce_clock_in`.
4. Attempt to update attendance correction fields directly.

Expected result: self-service operations succeed only for the current linked identity; cross-user and administrative field changes are denied.

## Evidence to retain

Store the following with the internal release record:

- commit SHA tested;
- internal deployment URL;
- test account category, not passwords;
- date and tester;
- `npm run test:workforce-permissions` output;
- complete `npm test` output;
- Supabase verification output;
- Pass/Fail matrix;
- screenshots of representative allow and deny states;
- related `workforce_audit_logs` rows for temporary permission and attendance corrections;
- defect links and retest results.

Never store passwords, access tokens, service-role keys, or session cookies in the evidence.

## Completion gate

Step 6 is complete only when:

- all automated tests pass;
- every Supabase blocker query returns zero rows;
- each required identity is available;
- all positive tests succeed;
- all direct URL, endpoint, RPC, and cross-team negative tests are denied;
- admin-only accounts cannot use Agent clock workflows;
- permission revocation is effective immediately;
- no existing login, password, dashboard, reporting, user-management, knowledge-base, article, schedule, or attendance regression is found.

Any failed scope-isolation or anonymous-access test blocks the limited internal deployment.
