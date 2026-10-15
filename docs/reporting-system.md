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

- approximately 9:00 PM `Asia/Manila`
- approximately 12:00 AM `Asia/Manila`

Google Apps Script time triggers are approximate; they do not guarantee
execution at the exact minute. The IANA timezone setting keeps the schedule
anchored to Manila local time throughout the year. The migration deletes and
reinstalls all managed triggers, including correctly named ones, and removes
retired dashboard handlers. Apps Script does not expose the
configured hour, minute, recurrence, or timezone for existing triggers, so
reinstalling is required to replace a misconfigured trigger safely. The
migration records the newly created trigger IDs and schedule configuration;
`inspectDashboardSyncTriggers()` confirms that the current IDs still match
that installation record. Re-running the migration is safe, but it replaces
the managed triggers each time.

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

Agent keys are derived from workbook display names because the source does not
provide immutable agent IDs. The importer first matches normalized source names
against `agent_identity_map`, so a verified display-name change can keep using
the existing stable key. If a new key appears on a report date that already has
productivity rows, the sync returns an identity conflict before writing any
Analytics data. Verify whether the changed header is the same person. For a
verified rename, update that person's existing `agent_identity_map.agent_name`
through authorized database administration while preserving `agent_key`, then
replay the same reporting dates.

For a genuinely new person, verify their identity against the current roster,
derive the key using the same normalized workbook-header format, and register
that name and key in `agent_identity_map` with
`dashboard_sync_approved = true` before retrying. The approval column defaults
to false; a normal sync cannot grant its own approval. An authorized database
operator can register a verified new person with a plain insert such as:

```sql
insert into public.agent_identity_map (
  agent_key,
  agent_name,
  dashboard_sync_approved
) values (
  'new_support_agent',
  'New Support Agent',
  true
);
```

Use the exact key derived from the workbook header. The insert intentionally
fails if that key already exists; inspect the existing identity instead of
overwriting it. Do not approve a changed header as a new agent until the rename
check is complete. The importer preserves historical rows and does not guess
that two names belong to the same person.

### Production release order

1. Apply the Dashboard Analytics schema migration
   `20261012132044_dashboard_agent_identity_approval.sql`. The endpoint reads
   this explicit approval field, so the migration must be live first.
2. Release the dashboard sync endpoint and its shared validation code through
   the approved production site workflow.
3. In the live workbook's Apps Script project, update `dashboard-sync.gs` and
   `dashboard-trigger-migration.gs` from the same reviewed release commit.
   Keep the existing `DASHBOARD_SYNC_URL` and `SHEET_SYNC_SECRET` script
   properties.
4. Run `migrateDashboardSyncTriggers()` and confirm its result is `valid: true`,
   with exactly one trigger for each configured Manila schedule. The migration
   deletes and reinstalls all managed triggers because Apps Script does not
   expose existing trigger schedule metadata.
5. Run `syncAllDashboardData()` once as the controlled manual sync.
6. Verify the latest `sheet_sync_runs` row is successful and covers the source
   workbook's latest valid reporting date. Confirm Daily Volume,
   Ticket Productivity, and Daily Drivers counts and keys, and verify
   Reporting Operations no longer reports a stale synchronization.

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

