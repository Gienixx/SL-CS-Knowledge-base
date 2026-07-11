# Workforce Identity Links

## Purpose

Supabase Auth users and workforce profiles normally share the same UUID. Some legacy, dummy, recreated, or renamed accounts can instead have an Auth UUID that differs from the workforce profile UUID used by schedules and other workforce records.

Without an explicit link, Row-Level Security treats those records as belonging to another person. Administrators can still see the row through team scope, but the affected employee sees an empty My Schedule page.

## Implementation

Migration `2026070705_workforce_identity_links.sql` adds `public.workforce_identity_links` with auditable Auth-user-to-profile pairs.

Migration `2026070706_workforce_identity_coverage.sql` validates and enforces coverage across the entire existing site population. It does not target only Arby or the dummy test account.

Links are backfilled through:

- Exact Auth UUID matches
- Exact normalized email matches
- Unique legacy name or email-local-part aliases

The all-user coverage migration then verifies:

- Every Supabase Auth account present in `public.login` has at least one active workforce-profile link
- Every active agent profile owning a schedule, attendance record, or leave request is linked to an Auth account
- Ambiguous inferred aliases do not silently grant access
- Future profile creation or email changes synchronize exact links and revoke stale automatic email links
- Inactive accounts remain inactive; identity linking does not reactivate them

If any current account or workforce-record owner remains unresolved, the coverage migration raises an exception and rolls back instead of leaving a partially repaired deployment.

## Authorization behavior

`workforce_is_current_identity(profile_user_id)` returns true only when the requested workforce profile is:

- The current `auth.uid()`, or
- Explicitly linked to the current Auth account in `workforce_identity_links`

The helper is used by profile visibility, schedule visibility, attendance visibility, permission checks, supervisor checks, and the central workforce access service.

The identity-link table is not directly readable by browser roles. It is consumed only by security-definer functions.

## Account provisioning

The `zz_login_workforce_identity_link` trigger runs after login synchronization and creates an exact identity link for newly provisioned accounts.

The `profiles_workforce_identity_link` trigger handles profiles created or updated outside the ordinary login flow. It also disables stale automatic email links after an email reassignment. Correctly created future users should not require legacy alias repair.

## Deployment

Run the files in this exact order in Supabase SQL Editor:

1. `supabase/migrations-legacy/2026070705_workforce_identity_links.sql`
2. `supabase/migrations-legacy/2026070706_workforce_identity_coverage.sql`
3. `supabase/verification/workforce_identity_coverage_check.sql`

Expected verification results:

- All required-object booleans return `true`
- The unlinked site-account query returns zero rows
- The unlinked workforce-record-owner query returns zero rows
- The ambiguous inferred-alias query returns zero rows
- The account coverage table contains every current site login
- The linked-schedule table includes legacy schedules attached to non-identical profile UUIDs, including the affected test account where applicable
- A recent `workforce_identity_coverage_verified` audit entry exists

After the SQL deployment, sign out and sign back in or hard-refresh My Schedule after Cloudflare finishes deploying the frontend changes.

## Troubleshooting

When Team Schedule shows an employee row but the same logged-in person sees zero entries in My Schedule:

- Confirm the row is inside the selected date range
- Confirm its status is Published, Changed, or Completed for regular agents
- Run the all-user identity coverage verification script
- Locate the Auth email in the account coverage table
- Confirm the scheduled workforce profile appears inside its linked-profile JSON

Do not weaken RLS or expose all team schedules to regular agents as a workaround.
