# Reporting system

## Architecture

The reporting system receives workbook data through `apps-script/dashboard-sync.gs`, posts it to the protected Cloudflare Pages Function at `/api/sync-dashboard`, validates and maps the payload, and writes synchronized reporting records to Supabase.

The active reporting UI consists of:

- `dashboard.html` — overview
- `report-details.html` — detailed trends and comparisons
- `agent-analytics.html` — productivity and available agent dimensions
- `response-times.html` — response and resolution metrics when supported by synchronized counts
- `reporting-operations.html` — administrator-only synchronization status, quality checks, alerts, audit history, and CSV exports

## Source policy

Google Sheet is the only active reporting source. No live browser module or Cloudflare synchronization endpoint reads Zendesk.

The source workbook currently uses:

- Daily Volume
- Ticket Productivity
- Daily Drivers

No additional workbook tab is required for the base reporting flow. Agent cross-filters appear only when `agent_dimension_metrics` contains synchronized records.

## Synchronization

Configure these Google Apps Script properties:

- `DASHBOARD_SYNC_URL` — the deployed site URL ending in `/api/sync-dashboard`
- `SHEET_SYNC_SECRET` — the shared bearer secret configured in Cloudflare

Run `migrateDashboardSyncTriggers()` from the workbook script to install or
repair the two managed daily synchronizations:

- approximately 9:00 AM `America/New_York`
- approximately 12:00 PM `America/New_York`

Google Apps Script time triggers are approximate; they do not guarantee
execution at the exact minute. The IANA timezone setting follows Eastern
daylight-saving changes. The migration retains one of each desired trigger,
removes duplicates and retired dashboard handlers, and creates only missing
triggers. Re-running it is safe. Run `inspectDashboardSyncTriggers()` afterward
and confirm that `valid` is `true` and that exactly two managed triggers are
listed.

The productivity importer reads each agent name and its three metric columns
from the workbook's two header rows. Agent names and positions may change, but
each populated block must contain `Solved Ticket`, `Open Tickets`, and `AHT`
in that order. Duplicate, shifted, incomplete, or unnamed populated blocks fail
validation before any raw or analytics data is written. `syncAllDashboardData()`
remains available for a manual full-workbook sync; analytics rows are upserted
by their existing logical keys, so replaying the same snapshot does not create
duplicate metric records. Apps Script logs identify the failed stage, including
source setup, properties, payload construction, and endpoint response. Authenticated
malformed requests are also recorded as failed sync runs; unauthorized requests
are rejected without creating a sync record.

## Operations

`/reporting-operations.html` is restricted to active administrators who retain the explicit `view_workforce_reports` permission. The browser hides the navigation link and blocks page initialization for other users, while Supabase RLS protects the underlying synchronization, quality, alert, and audit records from direct access.

Authorized administrators can review:

- latest synchronization status and age
- imported row count and latest report date
- quality checks
- current alerts
- synchronization and audit history
- authenticated CSV exports

A freshness warning appears when no successful synchronization completed within 30 hours. Quality warnings remain visible until a later synchronization passes the same check.

## Missing data

The UI never reconstructs unsupported metrics. Response time, resolution time, dimensions, targets, or comparisons are displayed only when the corresponding synchronized fields or configuration rows exist.
