# Phase 3 Step 5 — Period comparisons

Phase 3 Step 5 adds previous-period context to the main dashboard KPI cards while preserving the Phase 3 Step 4 global-filter contract.

## Dashboard behavior

The five visible operational KPI cards show:

```text
current value
percentage change or a defined zero-baseline state
previous-period value
```

Covered cards:

```text
Created Tickets
Solved Tickets
Open Backlog
Backlog Over 24h
Reopened Tickets
```

The server response also includes comparison values for:

```text
Backlog Over 48h
Average first-response minutes
Average resolution minutes
```

These extra metrics are available for later dashboard cards without another database migration.

## Comparison periods

The browser passes the active global-filter range type to:

```text
get_dashboard_period_comparison
```

Period rules:

- Last 7, 30, or 90 days compare with the immediately preceding equal-length period.
- Month to date compares with the same elapsed number of days in the previous month.
- A custom range covering one complete calendar month compares with the complete previous calendar month.
- Other custom ranges compare with the immediately preceding equal-length period.
- Prior-month MTD is capped at that month’s final day, so February and other unequal month lengths remain valid.

Example:

```text
Current: March 1–31
Previous: February 1–28 or 29
```

## Zero and missing values

When the previous value is zero:

- current zero returns `No change · prev 0`;
- current greater than zero returns `New · prev 0`;
- percentage change remains `null` because division by zero is undefined.

When either period has no numeric value, the card shows `No prior data` rather than fabricating a percentage.

The Step 4 RPC already produces a complete daily date spine for ticket counts. Missing calendar days therefore remain represented as zero-volume dates instead of shortening a rolling period.

## Database migrations

Apply:

```text
supabase/migrations/20260702_phase3_step5_period_comparisons.sql
```

The migration creates:

```text
get_dashboard_period_comparison
```

The function calls `get_dashboard_filtered_data` once for the current period and once for the previous period. App, platform, country, Concern, agent, priority, and channel filters are identical for both calls.

If the dashboard displays `Comparison unavailable` after the function migration has been applied, also apply:

```text
supabase/migrations/20260702_phase3_step5b_refresh_period_comparison_rpc.sql
```

The Step 5b migration reapplies the authenticated execution grant and explicitly tells PostgREST to refresh its schema cache. This resolves cases where PostgreSQL contains the new function but the Supabase browser RPC layer has not registered it yet.

The equivalent immediate SQL repair is:

```sql
NOTIFY pgrst, 'reload schema';
SELECT pg_notification_queue_usage();
```

## Security

- `authenticated` and `service_role` can execute the comparison RPC.
- `anon` cannot execute it.
- The browser still cannot read raw `ticket_events` or `ticket_dimension_profiles`.
- No new Cloudflare secret or environment variable is required.

## Frontend files

```text
scripts/dashboard-period-comparisons.js
dashboard-period-comparisons.css
```

The module listens for the existing:

```text
dashboard:filtered-data
```

event, requests the matching comparison payload, rejects stale responses, and updates the KPI cards.

## Verification

Run:

```text
supabase/verification/phase3_step5_period_comparisons_check.sql
```

Expected checks:

```text
authenticated_execute     PASS
anonymous_denied          PASS
required_function         PASS
reuses_filtered_contract  PASS
zero_baseline_handling    PASS
```

For an end-to-end database execution probe, run:

```text
supabase/verification/phase3_step5b_period_comparison_runtime_check.sql
```

The result should show:

```text
runtime_comparison_rpc  PASS
```

Then run:

```bash
npm run test:phase3-step5
npm run test:phase3-step4
```

## Manual production sequence

1. Apply `supabase/migrations/20260702_phase3_step5_period_comparisons.sql` in the Supabase SQL Editor.
2. Apply `supabase/migrations/20260702_phase3_step5b_refresh_period_comparison_rpc.sql` to refresh the browser-facing RPC schema.
3. Run `supabase/verification/phase3_step5_period_comparisons_check.sql` and confirm every check is `PASS`.
4. Run `supabase/verification/phase3_step5b_period_comparison_runtime_check.sql` and confirm `runtime_comparison_rpc` is `PASS`.
5. Confirm Cloudflare Pages deploys the latest Step 5 commit.
6. Hard-refresh the dashboard and test Last 7 days, Month to date, and one full calendar month selected through Custom range.
7. Confirm each KPI card shows a previous value and either a percentage, `New`, `No change`, or `No prior data`.

No Zendesk backfill and no new Cloudflare environment variable are required for Step 5.
