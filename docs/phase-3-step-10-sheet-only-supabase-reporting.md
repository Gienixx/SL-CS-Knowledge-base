# Phase 3 Step 10: sheet-only Supabase reporting

## Goal

Make the synchronized Google Sheet tables the only active reporting data source in Supabase. Zendesk tables and historical records remain unchanged for rollback and audit purposes, but active reporting RPCs no longer read them.

Step 10 does not add or require any new workbook tabs. It uses only:

- `Daily Volume`
- `Daily Drivers`
- `Ticket Productivity`

The existing Apps Script function `syncAllDashboardData()` and the protected `POST /api/sync-dashboard` endpoint remain the synchronization path.

## Active reporting tables

The existing synchronization continues to write these tables:

- `daily_ticket_metrics`
- `daily_distribution_metrics`
- `agent_productivity`
- `ticket_driver_metrics`

`agent_dimension_metrics` remains available as a reserved sheet-backed table. It stays empty until the existing workbook provides agent-level dimensions. Step 10 does not derive or invent those values from Zendesk.

## Synchronization observability

Migrations:

```text
supabase/migrations/2026070302_phase3_step10_sheet_only_schema.sql
supabase/migrations/2026070303_phase3_step10_sheet_only_dashboard_rpc.sql
supabase/migrations/2026070304_phase3_step10_sheet_only_agent_rpc.sql
```

Together they add:

- `reporting_source` and `quality_status` to `sheet_sync_runs`;
- `dashboard_sync_runs`, a reporting-oriented view of the existing sync history;
- `dashboard_data_quality_results`, containing per-run validation checks;
- an automatic trigger that records quality results after every successful or failed Google Sheet synchronization;
- `get_dashboard_reporting_status()`, which returns the latest sync, quality checks, and latest date in each reporting table.

A successful synchronization checks that rows were imported, a latest report date was supplied, all four active reporting tables contain data, and their latest dates are aligned. A date mismatch is a warning rather than a hard failure because an existing workbook tab can legitimately have no values for the newest date.

## Sheet-only reporting RPCs

The migration replaces the active implementations of:

```text
get_dashboard_filtered_data(...)
get_agent_analytics_dashboard(...)
```

Both functions read only Google Sheet–backed reporting tables. Their active definitions do not query:

- `ticket_events`
- `ticket_dimension_profiles`
- `agent_identity_map`
- `zendesk_agent_directory`

Only date filtering is reliable with the current workbook. The dashboard RPC rejects app, platform, country, driver, agent, priority, or channel intersection filters rather than returning misleading results. App, platform, country, driver, and agent totals remain available as independent sheet-based breakdowns.

Agent reporting returns only values present in `Ticket Productivity`: solved tickets, open tickets, and AHT. Team one-touch resolution remains available from `Daily Volume`. First-response, resolution, and reopen metrics return `null` because the existing workbook does not provide them.

## Apply Step 10

1. Run these migrations in order in the Supabase SQL Editor:

```text
supabase/migrations/2026070302_phase3_step10_sheet_only_schema.sql
supabase/migrations/2026070303_phase3_step10_sheet_only_dashboard_rpc.sql
supabase/migrations/2026070304_phase3_step10_sheet_only_agent_rpc.sql
```

2. Run `syncAllDashboardData()` once from the Google Sheet Apps Script project. The existing daily trigger can remain unchanged.
3. Confirm the Apps Script execution returns `success: true`.
4. Run the verification query:

```text
supabase/verification/phase3_step10_sheet_only_reporting_check.sql
```

The object and RPC checks must return `PASS`. The latest sync checks return `REVIEW` until one post-migration synchronization has completed. A latest-date mismatch may also return `REVIEW` when one source tab has no values for the newest reporting date.

## Rollback boundary

Step 10 does not drop or alter Zendesk event, ticket-profile, agent-directory, or identity-map data. The disabled Zendesk endpoints and no-op Worker from Step 8 remain unchanged. Removing historical Zendesk storage belongs to a later cleanup step, not this migration.
