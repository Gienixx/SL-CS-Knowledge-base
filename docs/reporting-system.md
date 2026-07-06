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

Run `syncAllDashboardData()` from the workbook script. Successful and failed runs are recorded in the reporting operations tables.

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
