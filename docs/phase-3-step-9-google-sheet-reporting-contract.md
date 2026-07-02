# Phase 3 Step 9: expanded Google Sheet reporting contract

## Purpose

Step 9 expands the Google Sheet contract so the dashboard can calculate
agent productivity, response-time, resolution-time, reopen, one-touch, worked
hours, and agent-level dimension reporting without Zendesk.

The existing payload version 2 endpoint remains available during rollout.
Step 9 uses a separate protected endpoint:

```text
POST /api/sync-dashboard-v3
```

The new endpoint requires the existing `SHEET_SYNC_SECRET`,
`SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` Cloudflare variables.

## Required workbook tabs

### Ticket Productivity V3

This is the normalized Step 9 table with one row per reporting date and agent.
It deliberately uses a different tab name from the existing legacy
`Ticket Productivity` worksheet.

```text
report_date
agent_key
agent_name
solved_tickets
open_tickets
handled_tickets
handle_minutes_total
responded_tickets
first_response_minutes_total
first_response_median_minutes
resolved_tickets
resolution_minutes_total
resolution_median_minutes
reopened_tickets
one_touch_tickets
worked_hours
```

`agent_key` is permanent. It must not change when an agent display name
changes, and it must never be reused for another person.

The legacy `Ticket Productivity` tab may remain in the workbook unchanged.
Step 9 does not read, rename, clear, or overwrite it. Only
`Ticket Productivity V3` is sent as the version 3 productivity dataset.

### Daily Ticket Metrics

This is one row per reporting date.

```text
report_date
new_tickets
solved_tickets
unsolved_tickets
one_touch_resolution
reopened_rate
responded_tickets
first_response_minutes_total
first_response_median_minutes
resolved_tickets
resolution_minutes_total
resolution_median_minutes
reopened_tickets
one_touch_tickets
```

`one_touch_resolution` and `reopened_rate` are decimal ratios from `0` through
`1`, not percentages from `0` through `100`.

### Agent Dimension Metrics

This is one row per reporting date, agent, dimension type, and dimension value.
The `agent_key` and `agent_name` values must match `Ticket Productivity V3`.

```text
report_date
agent_key
agent_name
dimension_type
dimension_key
dimension_label
ticket_count
```

Allowed `dimension_type` values:

```text
app
platform
country
concern
priority
channel
```

Use a stable `dimension_key`. Use `unknown` when the source field is missing so
the dimension total can still reconcile to the agent's `handled_tickets`.

### Data Dictionary

```text
tab_name
column_name
data_type
required
definition
validation_rule
```

The tab must document every column in all five Step 9 tabs. The supplied Apps
Script generates the complete dictionary, including the
`Ticket Productivity V3` tab name.

### Sync Metadata

Exactly one data row is sent per synchronization.

```text
contract_version
generated_at
source_time_zone
test_window_start
test_window_end
test_days_count
producer
```

The source time zone must be `America/New_York` and the contract version must be
`3`.

## Validation rules

The server rejects the entire payload before writing reporting rows when any of
these checks fail:

- required tabs or columns are missing or reordered;
- the productivity dataset is labeled `Ticket Productivity` instead of
  `Ticket Productivity V3`;
- an `agent_key` is invalid or maps to multiple names in the test window;
- duplicate report-date or agent keys exist;
- counts or minute totals are negative;
- responded or resolved counts exceed handled tickets;
- one-touch counts exceed resolved tickets;
- team solved, response, resolution, reopen, one-touch, or minute totals do not
  equal the sum of the agent rows;
- a supplied agent dimension total does not equal `handled_tickets`;
- the Data Dictionary does not document every contract column;
- Sync Metadata does not match the Daily Ticket Metrics date window.

The endpoint continues to import valid windows shorter than seven days but
returns `readyForProduction: false`.

## Database changes

Migration:

```text
supabase/migrations/2026070301_phase3_step9_google_sheet_reporting_contract.sql
```

It:

- adds the Step 9 team fields to `daily_ticket_metrics`;
- adds the Step 9 productivity fields to `agent_productivity`;
- creates `agent_dimension_metrics`;
- creates `reporting_data_dictionary`;
- creates `sheet_sync_metadata`;
- preserves the existing version 2 columns and tables;
- applies non-negative checks, unique keys, indexes, and read-only browser RLS.

## Apps Script installation

Use:

```text
apps-script/phase3-step9-reporting-contract.gs
```

1. Open the Google Sheet's Apps Script project.
2. Add or replace the file contents in the project.
3. Confirm the spreadsheet time zone is `America/New_York`.
4. Run `setupPhase3Step9Tabs()`.

No worksheet rename is required. The setup function leaves the existing
`Ticket Productivity` tab unchanged and creates a separate
`Ticket Productivity V3` tab with the normalized Step 9 headers.

If `Ticket Productivity V3` already exists with incorrect headers, correct only
that Step 9 tab before running setup again. The legacy tab remains unaffected.

Add these Script Properties:

```text
DASHBOARD_SYNC_URL=https://<production-pages-domain>/api/sync-dashboard-v3
SHEET_SYNC_SECRET=<same value configured in Cloudflare Pages>
```

Run:

```text
syncPhase3Step9Dashboard()
```

The script refreshes Sync Metadata, builds payload version 3, and sends all five
Step 9 tabs to the protected endpoint. It does not include the legacy
`Ticket Productivity` tab.

Do not replace the current production trigger until one manual Step 9 sync
succeeds.

## Exit criteria

Step 9 is accepted only after all of the following are true:

1. Seven consecutive reporting dates have synchronized successfully.
2. `agent_key` values remain stable throughout the window.
3. Team totals reconcile with the agent rows for every date.
4. Supplied agent-dimension totals reconcile with handled tickets.
5. Every contract column is documented in Data Dictionary.
6. The latest Sync Metadata row reports `ready_for_production = true`.
7. The verification query returns `PASS` for every check.

Verification query:

```text
supabase/verification/phase3_step9_google_sheet_contract_check.sql
```

## Automated tests

```bash
npm run test:phase3-step9
```

The suite tests the schema definition, legacy-tab isolation, seven-day
readiness, short-window behavior, total reconciliation, stable agent keys,
dimension reconciliation, dictionary completeness, endpoint wiring, migration
coverage, and Apps Script setup.
