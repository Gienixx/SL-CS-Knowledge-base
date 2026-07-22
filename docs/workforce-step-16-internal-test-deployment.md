# Phase 1, Step 16 — Internal Test Deployment

## Environment

- Supabase project: the connected internal workforce project
- Cloudflare Pages project: `sl-base`
- Stable preview branch alias: `internal-test.sl-cs-knowledge-base.pages.dev`
- Production remains on the `main` Pages branch.

The preview deployment uses the same tested site and Pages Functions bundle as
production. The current Supabase project contains the internal roster and Test
Team used for the attendance-cycle validation.

## Required test-user matrix

The read-only verification at
`supabase/verification/internal_test_access_matrix_check.sql` requires at least
one active Supabase Auth identity for each of these categories:

1. Regular agent
2. Agent with editor access
3. Admin and Agent
4. Admin only
5. Scoped supervisor
6. Payroll-authorized user

The Test Team supervisor receives only `manage_schedules`,
`view_team_attendance`, and `approve_leave`. The migration deliberately does
not grant employee administration, attendance correction, attendance approval,
or payroll access.

## Deployment gate

1. Apply all pending migrations through
   `ensure_internal_test_access_matrix`.
2. Run `internal_test_access_matrix_check.sql`; every BLOCKER query must return
   zero rows.
3. Confirm the July 1–15 payroll-readiness audit remains fully ready.
4. Compile the Pages Functions bundle and run the release-critical tests.
5. Deploy the tested bundle to the `internal-test` Pages preview branch.
6. Verify the preview alias returns the login, attendance, Team Attendance,
   leave-request, and workforce pages successfully.

Step 16 prepares the environment and identities only. The end-to-end actions
belong to Step 17's complete attendance cycle.

## Deployment record — July 22, 2026

- Supabase migration: `ensure_internal_test_access_matrix`
- Cloudflare deployment ID: `6786613b-2e31-441c-b726-bc2335ee6332`
- Immutable preview: `https://6786613b.sl-cs-knowledge-base.pages.dev`
- Stable preview: `https://internal-test.sl-cs-knowledge-base.pages.dev`
- Required access categories: 6 of 6 available
- Access-matrix blockers: 0
- July 1–15 payroll-readiness blockers: 0
- Release-critical tests: 20 passed, 0 failed
- Pages Functions compilation: passed
- Unauthenticated protected-function check: HTTP 401

## Production promotion — July 22, 2026

- Cloudflare production deployment ID: `51184c58-e98d-44b3-8bec-c33350be31f0`
- Immutable production deployment: `https://51184c58.sl-cs-knowledge-base.pages.dev`
- Canonical production site: `https://sl-cs-knowledge-base.pages.dev`
- Production branch: `main`
- Login, Attendance, Team Attendance, Leave Requests, and Workforce Management:
  HTTP 200
- Unauthenticated protected-function check: HTTP 401
