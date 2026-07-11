# Reporting Operations administrator access

Reporting Operations is restricted to users who satisfy both conditions:

- the active workforce profile has administrator scope
- the explicit `view_workforce_reports` permission is granted

## Components

- `dashboard.html` hides the Reporting Operations navigation link by default.
- `scripts/dashboard.js` shows the link only after the central workforce permission service confirms both conditions.
- `scripts/reporting-operations-entry.js` prevents the operational module from loading for unauthorized users.
- `2026070607_reporting_operations_admin_access.sql` applies the same rule through Supabase RLS and the export-audit RPC.

## Deployment

1. Apply `supabase/migrations-legacy/2026070607_reporting_operations_admin_access.sql`.
2. Run `supabase/verification/reporting_operations_admin_access_check.sql`.
3. Deploy the site from the matching tested commit.
4. Confirm an administrator can open Reporting Operations.
5. Confirm an agent/editor cannot see the link and is redirected when opening the page URL directly.

The general Dashboard, Agent Analytics, Response Times, and report detail pages remain available to approved users. This restriction applies only to operational monitoring, audit, alert, quality, synchronization-history, and export-management features.
