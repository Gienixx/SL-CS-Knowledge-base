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

The browser sends the selected filter state to one Supabase RPC. It does not download `ticket_events` and filter them locally.

## Database migration

Apply:

```text
supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql
```

The migration creates:

```text
ticket_dimension_profiles
upsert_ticket_dimension_profiles
get_dashboard_filtered_data
```

It also creates the independent Zendesk cursor:

```text
ticket_profiles
```

`ticket_dimension_profiles` stores the latest non-PII dimensions for each ticket. Ticket events remain immutable.

## Zendesk custom-field mappings

Add the applicable field IDs to the Cloudflare Pages environment:

```text
ZENDESK_APP_FIELD_ID
ZENDESK_PLATFORM_FIELD_ID
ZENDESK_COUNTRY_FIELD_ID
ZENDESK_DRIVER_FIELD_ID
```

Only numeric Zendesk ticket-field IDs are accepted.

Agent, priority, and channel are populated from standard Zendesk ticket properties and do not require custom-field IDs.

A missing custom-field ID does not block synchronization. Its dashboard filter remains empty until a mapping is configured and profiles are backfilled.

## Historical profile backfill

Protected endpoint:

```text
POST /api/backfill-zendesk-ticket-profiles
Authorization: Bearer <ZENDESK_SYNC_SECRET>
Content-Type: application/json
```

Optional first-request body:

```json
{
  "startTime": 1767225600
}
```

`startTime` is a Unix timestamp in seconds. It is used only before the `ticket_profiles` cursor has been established.

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

The normal `/api/sync-zendesk` endpoint now maintains profiles on every future ticket snapshot page, so the historical endpoint is a one-time backfill unless the cursor is intentionally reset.

Optional Pages values:

```text
ZENDESK_PROFILE_INITIAL_START_TIME
ZENDESK_PROFILE_PAGE_SIZE
```

The profile page size defaults to 100 and is capped at 100.

## Filter semantics

Created and solved counts apply to the selected date range.

Open backlog is evaluated at the end of the selected date range.

App, platform, country, driver, agent, priority, and channel are matched from the latest ticket profile. This is appropriate for operational filtering, but it is not a historical slowly-changing dimension model.

The RPC caps a selected date range at 366 days.

## Access model

- Authenticated users can execute the aggregated filter RPC.
- Anonymous users cannot execute it.
- Browser users cannot read `ticket_dimension_profiles` directly.
- Only the service role can write or backfill ticket profiles.
- The profile backfill endpoint uses the existing synchronization bearer secret.

## Verification

After applying the migration and completing the backfill, run:

```text
supabase/verification/phase3_step4_global_filters_check.sql
```

Expected checks:

```text
authenticated_filter_rpc     PASS
required_objects             PASS
row_level_security           PASS
server_only_profile_table    PASS
ticket_profile_cursor_state  PASS
ticket_profile_integrity     PASS
ticket_profile_uniqueness    PASS
```

## Tests

```bash
npm run test:phase3-step4
npm run test:phase3-step2
npm run test:phase3-step3
npm run test:zendesk-integration
```
