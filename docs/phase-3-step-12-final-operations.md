# Phase 3 Step 12: final reporting operations and acceptance

## Goal

Complete Phase 3 with a production operations layer around the synchronized Google Sheet reporting system.

Step 12 adds:

- synchronization audit history;
- data-quality monitoring;
- current in-app alerts;
- CSV exports with export audit records;
- final removal of obsolete browser cutover shims;
- final sheet-only acceptance checks.

No active page, script, view, or reporting RPC uses Zendesk as a reporting source.

## Reporting Operations page

Open:

`/reporting-operations.html`

The page displays:

- latest synchronization status and age;
- latest synchronization quality status;
- latest report date and imported row count;
- active synchronization, quality, and freshness alerts;
- latest quality checks;
- synchronization history;
- operational audit events;
- CSV export controls.

The page is available to approved authenticated users and follows the same first-login password policy as the other dashboards.

## Audit history

`dashboard_audit_events` stores append-only records for:

- successful Google Sheet synchronizations;
- failed Google Sheet synchronizations;
- data-quality checks;
- authenticated CSV exports.

Existing synchronization and quality history is backfilled when the migration is applied. New events are created automatically by database triggers.

## Alerts

`dashboard_alert_events` stores alerts generated from:

- synchronization failures;
- failed data-quality checks;
- data-quality warnings.

`dashboard_active_alerts` adds a computed freshness alert when there is no successful synchronization or the latest successful synchronization completed more than 30 hours ago.

Alerts are in-app operational alerts. Step 12 does not add an external email, Slack, or paging dependency.

## CSV exports

The operations page can export:

- daily ticket metrics;
- daily distribution metrics;
- agent productivity;
- ticket drivers;
- agent dimensions;
- synchronization history;
- data-quality results;
- alert history;
- audit history.

Exports are generated locally in the authenticated browser. The exported dataset, row count, optional date range, timestamp, and authenticated email are recorded through `record_dashboard_export(...)`.

## Cleanup

The following browser compatibility shims are removed because the final Step 11 dashboards no longer use them:

- `scripts/report-details-agent-redirect.js`
- `scripts/reporting-source-cutover.js`
- `scripts/response-times-base.js`

Historical SQL migrations and disabled Zendesk endpoints remain in the repository for audit and rollback context. They are not active reporting dependencies.

## Apply Step 12

1. Run this migration in the Supabase SQL Editor:

   `supabase/migrations/2026070402_phase3_step12_reporting_operations.sql`

2. Deploy the merged website build.
3. Run:

   `supabase/verification/phase3_step12_final_acceptance_check.sql`

4. Open `/reporting-operations.html`.
5. Confirm the latest synchronization and quality checks match the existing Step 10 status.
6. Create one CSV export and confirm a `csv_export` row appears in Audit Events.
7. Confirm `dashboard_active_alerts` is empty when the latest synchronization is healthy and recent, or displays an accurate warning when review is required.

## Expected verification results

Object, RLS, trigger, export-RPC, and sheet-only checks must return `PASS`.

`latest_sync_available` may return `REVIEW` until the first synchronization is completed. `latest_sync_quality` may return `REVIEW` when the current synchronization has a legitimate warning, such as a source tab that has no rows for the newest report date.

## Final Phase 3 boundary

- Google Sheet is the only active reporting source.
- No new workbook tabs are required.
- Missing metrics remain unavailable rather than inferred.
- Zendesk synchronization endpoints remain disabled.
- Historical Zendesk database objects may remain for rollback and audit, but no active reporting UI or JavaScript depends on them.
