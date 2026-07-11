# Phase 1, Step 11 — Attendance Correction Permissions

## Status

Implemented in `2026070903_attendance_correction_permissions.sql`.

## Permission model

Step 11 adds two independent workforce permissions:

- `correct_attendance`
- `approve_attendance`

These permissions are intentionally separate from:

- `view_team_attendance`
- `manage_payroll`
- `manage_schedules`
- the employee's supervisor assignment

A user may view Team Attendance without being allowed to modify or approve attendance. A payroll-authorized user may consume approved attendance later without receiving clock-record modification rights.

## Effective access rules

### Supervisors

Supervisors continue to use `view_team_attendance` and the existing assigned-team scope. Supervisor status alone never grants correction or approval rights.

### Authorized administrators

Attendance correction requires all of the following:

1. An active workforce profile.
2. Effective administrator status.
3. An explicit `correct_attendance` grant.

Attendance approval requires the same conditions with an explicit `approve_attendance` grant.

The helper functions prepared for the correction and approval workflows are:

- `workforce_is_authorized_attendance_admin(permission_key)`
- `workforce_can_correct_attendance(target_user_id)`
- `workforce_can_approve_attendance(target_user_id)`

The helpers do not use supervisor scope or `manage_payroll` as an authorization shortcut.

### System administrators

Profiles marked `is_system_admin = true` receive both new permissions during migration and retain them when saved through Workforce Management.

### Regular agents and supervisors who are not admins

The employee administration transaction forces both permissions off for any non-admin profile. This prevents an accidentally checked browser control from creating an invalid correction role.

## Workforce Management integration

The Employee editor now displays:

- Correct attendance
- Approve attendance

The shared `WORKFORCE_PERMISSION_KEYS` list and `workforce_get_current_access()` payload include both keys. The normalized browser access object also exposes:

- `can_correct_attendance`
- `can_approve_attendance`

Older clients that omit the new keys do not erase existing grants because the server preserves omitted attendance-permission values.

## Payroll separation

`manage_payroll` does not grant either attendance permission. This separation is deliberate:

- Attendance administrators create and approve trusted source records.
- Payroll users consume payroll-ready attendance.
- Payroll access alone cannot alter clock-in or clock-out records.

## Security boundary

Step 11 adds authorization helpers only. It does not add a browser write path to `attendance` and does not enable correction controls on `team-attendance.html` yet. Step 12 must use a security-definer correction RPC that calls `workforce_can_correct_attendance()` and records a mandatory structured correction reason.

## Deployment

Apply:

```text
supabase/migrations-legacy/2026070903_attendance_correction_permissions.sql
```

Then run:

```text
supabase/verification/attendance_correction_permissions_check.sql
```

Every blocker query in section 5 of the verification script must return zero rows.
