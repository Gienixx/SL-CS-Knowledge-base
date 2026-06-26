# Phase 2 Step 12 — Acceptance test

Step 12 closes Phase 2 by verifying that the ingestion pipeline, live dashboard,
detail pages, security controls, responsive behavior, and scheduled
synchronization operate together.

## Repository acceptance test

Run:

```bash
npm run test:phase2-acceptance
```

This command verifies:

- The live dashboard initializes ticket, distribution, agent, and driver data.
- Dashboard charts and rows link to all five detail-page views.
- Drill-down controls support mouse and keyboard activation.
- Detail pages provide historical charts, tables, and all date-range modes.
- AHT is interpreted as decimal minutes and displayed as `M:SS`.
- Idempotency, validation, and authenticated read-only migrations are present.
- Responsive and accessibility assets cover the required acceptance widths.
- The Apps Script migration targets one daily `syncAllDashboardData` trigger.
- The existing multi-dataset synchronization integrity tests still pass.

## Supabase acceptance verification

Run the read-only query:

```text
supabase/verification/phase2_step12_acceptance_check.sql
```

Expected automated results:

```text
metric_data_integrity              PASS
cross_table_date_consistency       PASS
unique_indexes                     PASS
authenticated_read_only_access     PASS
authenticated_policies             PASS
latest_apps_script_sync            PASS
```

`latest_apps_script_sync` returns `REVIEW` when the latest successful Apps Script
run is older than 36 hours. This normally means the trigger history should be
checked before Phase 2 is signed off.

The query does not modify the database. No new schema migration is required for
Step 12.

## Final Apps Script confirmation

The Supabase database cannot prove whether an Apps Script execution was launched
manually or by the installed daily trigger. In the workbook's Apps Script
project, run:

```text
inspectDashboardSyncTriggers
```

Confirm:

```text
valid: true
currentTriggerCount: 1
legacyTriggerCount: 0
handler: syncAllDashboardData
schedule: daily around 12 PM America/New_York
```

Then open **Executions** and confirm that the latest scheduled
`syncAllDashboardData` execution succeeded without manual intervention.

## Acceptance decision

Phase 2 is accepted when:

- `npm run test:phase2-acceptance` passes.
- Every automated Supabase check returns `PASS`.
- `inspectDashboardSyncTriggers` returns the expected trigger state.
- A scheduled Apps Script execution succeeds.
- The completed Step 11 viewport and keyboard checks remain valid.
