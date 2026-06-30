# Phase 3 Step 3 — Daily operations metrics

Phase 3 Step 3 derives daily operational KPIs from normalized Zendesk ticket events.

## Database migration

Apply:

```text
supabase/migrations/20260701_phase3_step3_daily_operations_metrics.sql
```

The migration creates:

```text
daily_operations_metrics
refresh_daily_operations_metrics
```

## Daily fields

```text
report_date
report_timezone
tickets_created
tickets_solved
backlog_open
backlog_over_24h
backlog_over_48h
first_response_minutes
resolution_minutes
sla_breaches
reopened_tickets
csat_score
calculated_at
source_system
```

## Metric definitions

### Tickets created

Distinct tickets whose `created` event occurs during the reporting day.

### Tickets solved

Distinct tickets with a `solved` event during the reporting day.

### Open backlog

Tickets created before the end of the reporting day whose latest lifecycle state at that point is not terminal.

Terminal lifecycle states are:

```text
solved
closed
```

A later `reopened` or non-terminal `status_changed` event returns the ticket to backlog.

### Backlog over 24 and 48 hours

Open backlog tickets whose age at the end of the reporting day is at least 24 or 48 elapsed hours.

The following integrity relationship is enforced by verification:

```text
backlog_over_48h <= backlog_over_24h <= backlog_open
```

### First-response minutes

Average Zendesk calendar first-response minutes for first-response events occurring on the reporting day.

The value comes from the normalized `calendar_minutes` ticket metric stored in event metadata.

### Resolution minutes

Average elapsed minutes from ticket creation to the latest terminal lifecycle event for tickets whose current final lifecycle state is solved or closed and whose terminal event occurs on the reporting day.

### Reopened tickets

Distinct tickets with a `reopened` event during the reporting day.

### SLA breaches and CSAT

These columns are intentionally nullable:

```text
sla_breaches
csat_score
```

Step 2 did not yet import a trusted SLA-breach or CSAT source. Null values mean unavailable, not zero. These fields can be populated when those sources are implemented in a later Phase 3 step.

## Reporting timezone

The default reporting timezone is:

```text
America/New_York
```

The Pages Function can override it through:

```text
OPERATIONS_TIME_ZONE
```

Use an IANA timezone name. Do not change the timezone after production history is established without intentionally rebuilding the table.

## Protected refresh endpoint

```text
POST /api/refresh-operations-metrics
```

The endpoint uses the existing synchronization bearer secret.

### Initial full refresh

```json
{
  "full": true
}
```

This rebuilds every report date represented in `ticket_events`, through the current reporting date.

### Scheduled rolling refresh

```json
{
  "full": false
}
```

When no explicit dates are supplied, the endpoint refreshes the latest 30 days. This captures late events and reopened-ticket changes without recalculating all history every day.

### Explicit date range

```json
{
  "startDate": "2026-06-01",
  "endDate": "2026-06-30"
}
```

Dates must use `YYYY-MM-DD`.

## Scheduled maintenance

After both Zendesk synchronization streams reach the end of their available pages, the 9:00 AM Eastern Cloudflare Worker calls:

```text
POST /api/refresh-operations-metrics
```

The Worker does not refresh metrics when either Zendesk stream stops before reaching `endOfStream`. This prevents daily aggregates from being published against a partially synchronized event state.

## Access model

- Authenticated users have read-only table access.
- Anonymous users have no access.
- The service role can refresh and maintain the table.
- The browser cannot execute the refresh function.

## Verification

After the migration and initial full refresh, run:

```text
supabase/verification/phase3_step3_daily_operations_check.sql
```

Expected checks:

```text
required_objects          PASS
report_date_uniqueness    PASS
metric_integrity          PASS
row_level_security        PASS
derived_rows_present      PASS
future_sources_nullable   PASS
```

## Tests

```bash
npm run test:phase3-step3
npm run test:zendesk-integration
```
