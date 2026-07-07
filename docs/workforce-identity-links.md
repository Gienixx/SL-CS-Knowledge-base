# Workforce Identity Links

## Purpose

Supabase Auth users and workforce profiles normally share the same UUID. Some legacy, dummy, recreated, or renamed accounts can instead have an Auth UUID that differs from the workforce profile UUID used by schedules and other workforce records.

Without an explicit link, Row-Level Security treats those records as belonging to another person. Administrators can still see the row through team scope, but the affected employee sees an empty My Schedule page.

## Implementation

Migration `2026070705_workforce_identity_links.sql` adds `public.workforce_identity_links` with auditable Auth-user-to-profile pairs.

Links are backfilled through:

- Exact Auth UUID matches
- Exact normalized email matches
- Unique legacy name or email-local-part aliases
- Future manual links when required

The alias backfill runs only when the Auth email local part is unique among Auth users.

## Authorization behavior

`workforce_is_current_identity(profile_user_id)` returns true only when the requested workforce profile is:

- The current `auth.uid()`, or
- Explicitly linked to the current Auth account in `workforce_identity_links`

The helper is used by profile visibility, schedule visibility, attendance visibility, permission checks, supervisor checks, and the central workforce access service.

The identity-link table is not directly readable by browser roles. It is consumed only by security-definer functions.

## Account provisioning

The `zz_login_workforce_identity_link` trigger runs after login synchronization and creates an exact identity link for newly provisioned accounts. Correctly created future users should therefore not require alias repair.

## Deployment

1. Apply `supabase/migrations/2026070705_workforce_identity_links.sql` in Supabase SQL Editor.
2. Run `supabase/verification/workforce_identity_links_check.sql`.
3. Confirm object and privilege checks are true.
4. Confirm the exact-link, safe-alias, and orphan blocker queries return zero rows.
5. Review the multi-profile identity result and confirm expected accounts such as Arby or the dummy test account.
6. Confirm the published-schedule query lists any existing schedule attached to a linked non-Auth UUID.
7. Sign out and sign back in, or hard-refresh My Schedule after Cloudflare and Supabase changes are available.

## Troubleshooting

When Team Schedule shows an employee row but the same logged-in person sees zero entries in My Schedule:

- Confirm the row is inside the selected date range.
- Confirm its status is Published, Changed, or Completed for regular agents.
- Run the identity-link verification script.
- Check that the Auth email appears with the workforce profile and schedule in the multi-profile or linked-schedule results.

Do not weaken RLS or expose all team schedules to regular agents as a workaround.
