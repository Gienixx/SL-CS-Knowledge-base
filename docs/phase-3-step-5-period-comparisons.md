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

The comparison payload also includes values for:

```text
Backlog Over 48h
Average first-response minutes
Average resolution minutes
```

## Browser execution model

The main dashboard request already returns the current-period summary through:

```text
get_dashboard_filtered_data
```

The browser reuses that current summary and makes only one additional `get_dashboard_filtered_data` request for the previous period. It calculates the differences locally and updates the KPI cards.

This avoids the former three-aggregation sequence:

```text
current dashboard aggregation
comparison RPC current aggregation
comparison RPC previous aggregation
```

The browser now performs two aggregations per refresh:

```text
current dashboard aggregation
previous-period aggregation
```

Repeated identical `dashboard:filtered-data` events are deduplicated while a comparison is in flight and after a successful render.

## Comparison periods

Period rules:

- Last 7, 30, or 90 days compare with the immediately preceding equal-length period.
- Month to date compares with the same elapsed number of days in the previous month.
- A custom range covering one complete calendar month compares with the complete previous calendar month.
- Other custom ranges compare with the immediately preceding equal-length period.
- Prior-month MTD is capped at that month’s final day.

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

When either period has no numeric value, the card shows `No prior data`.

## Required Step 4 dependency

Step 5 requires this exact Step 4 aggregate function:

```text
public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)
```

Apply:

```text
supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql
```

Verify with:

```text
supabase/verification/phase3_step5_dependency_check.sql
```

Expected result:

```text
step4_filtered_dashboard_rpc  PASS
```

## Step 5 database migration

The existing migration remains available for server-side comparison consumers:

```text
supabase/migrations/20260702_phase3_step5_period_comparisons.sql
```

It creates:

```text
get_dashboard_period_comparison
```

The production browser no longer calls this heavier function during normal dashboard rendering. It is retained as a server-side contract and for future backend consumers.

Apply the schema refresh migration when the RPC is newly created or its permissions change:

```text
supabase/migrations/20260702_phase3_step5b_refresh_period_comparison_rpc.sql
```

Equivalent immediate SQL:

```sql
NOTIFY pgrst, 'reload schema';
SELECT pg_notification_queue_usage();
```

## Concern compatibility loop prevention

The Concern compatibility layer no longer keeps a permanent `MutationObserver` over the whole document. It observes only during initial dashboard construction, disconnects once the filter and Concern targets exist, and then responds to explicit dashboard events.

This prevents unrelated KPI and loading-text changes from repeatedly scheduling Concern UI work.

## Verification

Run:

```text
supabase/verification/phase3_step5_dependency_check.sql
supabase/verification/phase3_step5_period_comparisons_check.sql
supabase/verification/phase3_step5b_period_comparison_runtime_check.sql
```

The Step 5b readiness check does not execute the full dashboard aggregation. It verifies function existence and authenticated execution privileges so the SQL Editor does not appear to run indefinitely on large ticket histories.

Expected readiness result:

```text
runtime_comparison_rpc  PASS
```

Then run:

```bash
npm run test:phase3-step5
npm run test:phase3-step4
```

## Manual production sequence

1. Apply `supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql` if the Step 4 RPC is missing.
2. Run `supabase/verification/phase3_step5_dependency_check.sql` and confirm `PASS`.
3. Apply the Step 5 and Step 5b migrations if they have not already been applied.
4. Run the Step 5 verification files and confirm `PASS`.
5. Confirm Cloudflare Pages deploys the latest loop-prevention commit.
6. Hard-refresh the dashboard.
7. Test Last 7 days, Month to date, and a full calendar month selected through Custom range.
8. Confirm the KPI cards settle on a single previous-period result rather than repeatedly returning to a loading state.

No Zendesk backfill and no new Cloudflare environment variable are required.
