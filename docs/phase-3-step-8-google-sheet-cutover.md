# Phase 3 Step 8: Google Sheet reporting cutover

## Goal

Make the synchronized Google Sheet dataset the only active reporting source while isolating Zendesk runtime access. Existing Zendesk database objects remain available temporarily for rollback and audit review.

## Runtime policy

The current policy is defined in `config/phase3-reporting-source-policy.js`.

- Active reporting source: `google_sheet`
- Zendesk synchronization: disabled
- Zendesk reporting RPC use: disabled in active report details
- Zendesk-only pages: retired or redirected
- Existing Zendesk tables and migrations: preserved

## Server-side isolation

The Zendesk connection test, snapshot sync, event sync, SLA sync, and dimension backfill endpoints now return a shared disabled response without reading Zendesk credentials or making network requests.

The shared response uses:

```text
HTTP 410
code: zendesk_integration_disabled
reportingSource: google_sheet
retryable: false
```

The scheduled Worker is now a no-op. Its scheduled handler records that synchronization was skipped, and its HTTP status response confirms that the integration is disabled.

## User-interface cutover

- The dashboard no longer links to the Zendesk-only Response Times page.
- The Response Times page returns users to the main dashboard.
- The Agent Analytics page routes to the Google Sheet Agent Productivity report.
- Report-detail URLs discard Zendesk-only dimension parameters.
- Zendesk source badges and dimension controls are hidden.
- The report-detail bootstrap blocks the Zendesk reporting RPC and returns empty filter options instead.
- User-facing copy identifies the synchronized Google Sheet dataset as the reporting source.

## Preserved data

This step intentionally leaves Zendesk-related Supabase tables, migrations, verification queries, and historical records intact. Removal belongs to a later cleanup step after the Google Sheet reporting path has been validated in production.

## Verification

Run:

```bash
node --test tests/phase3-step8-google-sheet-cutover.test.mjs
node --check functions/_shared/zendesk-disabled.js
node --check workers/zendesk-health/index.js
node --check scripts/report-details-agent-redirect.js
node --check scripts/reporting-source-cutover.js
```

## Production checks after merge

1. Confirm the Cloudflare Pages deployment succeeds.
2. Open the main dashboard and verify there is no Response Times navigation item.
3. Open several report-detail links and confirm only date controls are visible.
4. Open an older report-detail URL containing app, platform, country, concern, agent, priority, or channel parameters and confirm those parameters are removed before data loads.
5. Open the former Agent Analytics URL and confirm it routes to the Google Sheet Agent Productivity report.
6. Open the former Response Times URL and confirm it returns to the dashboard.
7. Confirm each disabled Zendesk endpoint returns the shared disabled response and makes no Zendesk request.
8. Confirm the deployed Worker status reports `enabled: false` and `reportingSource: google_sheet`.
9. Confirm Google Sheet ingestion and dashboard refresh continue normally.
10. Confirm existing Zendesk tables and records are still present.

## Manual action

After the pull request is merged, verify that the disabled Worker deployment workflow completes. This replaces any previously deployed active synchronization Worker with the no-op version.
