# Workforce Permission Service

## Purpose

Step 2 centralizes workforce authorization so browser interfaces, Cloudflare Pages Functions, and Supabase Row-Level Security use the same effective permission model.

## Components

- `public.workforce_get_current_access()` returns the authenticated user's active profile and explicitly granted permissions.
- `shared/workforce-access.js` normalizes access data and maps the four supported access types.
- `scripts/workforce-permissions.js` loads access through the Supabase RPC and temporarily falls back to `public.login` only when the RPC has not yet been deployed.
- `functions/_shared/workforce-auth.js` validates the bearer token and loads the same RPC result for server-side authorization.
- `functions/_middleware.js` protects global account-management endpoints before their existing handlers execute.

## Supported access types

| Access type | Profile mapping | Effective behavior |
| --- | --- | --- |
| Admin and Agent | `base_role = 'admin'`, `is_agent = true` | Global administrator scope plus agent workflows, subject to each explicit permission |
| Admin | `base_role = 'admin'`, `is_agent = false` | Global administrator scope without clock, schedule, or leave self-service, subject to each explicit permission |
| Regular Agent with Edit articles | `base_role = 'agent'`, `is_agent = true`, `edit_articles = true` | Regular agent workflows plus article management |
| Regular Agent | `base_role = 'agent'`, `is_agent = true` | No elevated workforce, article, or payroll permission |

Administrator status determines scope. It does not automatically grant a workforce permission. Revoking `manage_employees`, for example, prevents an administrator from using protected employee-management endpoints even while `base_role` remains `admin`.

## Compatibility behavior

`public.login.is_admin` and `public.login.can_edit_articles` remain temporarily as compatibility mirrors. Canonical interfaces authorize through `profiles` and `user_permissions`.

The browser and server adapters fall back to the legacy record only when `workforce_get_current_access()` is unavailable because the migration has not yet been applied. Other RPC errors are not silently ignored.

## Protected endpoints

The root Pages Function middleware requires both `base_role = 'admin'` and `manage_employees` for:

- `/create-user`
- `/resend-invite`
- `/update-employee`
- `/employee-lifecycle`
- `/change-password`

Endpoint-level checks remain as defense in depth.

## Deployment order

1. Apply `supabase/migrations-legacy/2026070605_workforce_permission_service.sql` in the internal Supabase environment.
2. Run `supabase/verification/workforce_permission_service_check.sql`.
3. Deploy the site and Pages Functions from the same tested commit.
4. Confirm the dashboard behavior for Admin and Agent, Admin, Regular Agent with Edit articles, and Regular Agent.
5. Confirm a revoked `manage_employees` permission receives HTTP 403 when calling a protected endpoint directly.
6. Confirm Employee Profiles and canonical article management behavior is unchanged.

## Rollback boundary

The code can be rolled back while leaving the RPC in place. The migration is additive and does not remove or rename `public.login` fields. Do not drop workforce tables during an application rollback.
