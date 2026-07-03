# Step 12 hotfix: synchronization-history visibility

## Symptom

The Reporting Operations page loads alerts, but the summary shows:

- Latest sync: Unavailable
- Quality status: Unavailable
- Report date: Unavailable
- Rows imported: Unavailable
- No synchronization history

It may also show both an older synchronization failure and a newer quality result as active alerts.

## Cause

`dashboard_sync_runs` is a `security_invoker` view. Authenticated users had SELECT permission on the view, but did not have both SELECT permission and an RLS read policy on its underlying `sheet_sync_runs` table. PostgreSQL therefore returned no visible synchronization rows to the browser.

The original Step 12 history backfill also opened every historical failure and warning. It did not resolve records that had already been superseded by a later successful synchronization or a newer result for the same quality check.

## Fix

Run:

`supabase/migrations/2026070403_phase3_step12_sync_history_visibility_fix.sql`

The migration:

- enables RLS on `sheet_sync_runs`;
- grants authenticated SELECT access;
- creates the authenticated read policy required by the security-invoker view;
- recreates `dashboard_sync_runs` and its grants;
- resolves failure alerts older than the latest successful synchronization;
- keeps only the latest open alert for each quality check;
- updates the quality trigger so later runs do not accumulate obsolete alerts.

Then run:

`supabase/verification/phase3_step12_sync_history_visibility_check.sql`

All checks should return `PASS`. `superseded_sync_failures_resolved` may return `REVIEW` only when no successful synchronization has ever completed.

## Expected page result

After refreshing `/reporting-operations.html`:

- the latest synchronization fields should contain values;
- synchronization history should list existing runs;
- the computed "No successful Google Sheet synchronization" alert should disappear when a success exists;
- failures older than the latest success should no longer be active;
- only the current warning or failure for each quality check should remain open.

A real current warning, such as mismatched latest dates across synchronized source tables, remains visible until a later synchronization passes that check.
