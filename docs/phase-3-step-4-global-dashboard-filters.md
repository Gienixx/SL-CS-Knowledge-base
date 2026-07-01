# Phase 3 Step 4 — Global dashboard filters

Phase 3 Step 4 adds a shared, URL-persistent filter bar to the main dashboard.

## Filters

```text
Date range
App
Platform
Country
Driver group
Agent
Priority
Channel
```

Supported date ranges:

```text
Last 7 days
Last 30 days
Last 90 days
Month to date
Custom range
```

Example:

```text
dashboard.html?range=30d&app=eureka&country=us
```

The browser sends the selected filter state to one Supabase RPC. It does not download `ticket_events` or `ticket_dimension_profiles` and filter them locally.

## Database migrations

Apply the existing ticket-dimension migration first:

```text
supabase/migrations/20260701_phase3_step4_ticket_dimension_profiles.sql
```

Then apply:

```text
supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql
```

The second migration creates:

```text
get_dashboard_filtered_data
```

The function returns filtered KPI totals, daily ticket trends, app/platform/country/driver/priority/channel breakdowns, agent workload, and valid filter options.

## Data sources

App, platform, country, and driver values come from the server-only `ticket_dimension_profiles` table.

Agent, priority, and channel values are derived from the latest valid values in normalized `ticket_events` as of the selected period end. Ticket events remain immutable.

## Zendesk custom-field mappings

Add the applicable numeric Zendesk ticket-field IDs to the Cloudflare Pages environment. The current normalizer accepts either naming form:

```text
ZENDESK_APP_CUSTOM_FIELD_ID
ZENDESK_APP_FIELD_ID

ZENDESK_PLATFORM_CUSTOM_FIELD_ID
ZENDESK_PLATFORM_FIELD_ID

ZENDESK_COUNTRY_CUSTOM_FIELD_ID
ZENDESK_COUNTRY_FIELD_ID

ZENDESK_DRIVER_CUSTOM_FIELD_ID
ZENDESK_DRIVER_FIELD_ID
```

App, platform, and country are required by the historical dimension backfill. Driver is optional.

## Historical dimension backfill

Protected endpoint:

```text
POST /api/backfill-zendesk-ticket-dimensions
Authorization: Bearer <ZENDESK_SYNC_SECRET>
Content-Type: application/json
```

The endpoint uses the independent cursor:

```text
ticket_dimensions_backfill
```

Repeat the request while:

```json
{
  "hasMore": true
}
```

Stop when:

```json
{
  "endOfStream": true
}
```

The normal `/api/sync-zendesk` endpoint maintains dimension profiles for future ticket snapshots.

Optional Pages values:

```text
ZENDESK_DIMENSION_INITIAL_START_TIME
ZENDESK_DIMENSION_PAGE_SIZE
```

## Filter semantics

Created and solved counts apply to the selected date range.

Open backlog is evaluated at the end of the selected date range.

Dimension filters use the latest ticket dimension available at the selected period end. This is an operational current-state model, not a historical slowly changing dimension model.

The RPC limits one request to 367 inclusive dates, equivalent to a maximum date difference of 366 days.

## Access model

- Authenticated users can execute the aggregate filter RPC.
- Anonymous users cannot execute it.
- Browser users cannot read `ticket_dimension_profiles` directly.
- Only the service role can maintain ticket dimensions.
- Historical backfill uses the existing synchronization bearer secret.

## Verification

After applying both migrations and completing the dimension backfill, run:

```text
supabase/verification/phase3_step4_ticket_dimension_check.sql
supabase/verification/phase3_step4_global_filters_check.sql
```

Expected global-filter checks:

```text
authenticated_filter_rpc   PASS
dimension_backfill_cursor  PASS
required_objects           PASS
server_only_profile_table  PASS
ticket_profile_rls         PASS
ticket_profile_uniqueness  PASS
```

## Tests

```bash
npm run test:phase3-step4
npm run test:phase3-step2
npm run test:phase3-step3
npm run test:zendesk-integration
```
