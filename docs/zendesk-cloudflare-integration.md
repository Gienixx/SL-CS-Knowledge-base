# Zendesk integration on Cloudflare

This repository contains protected Cloudflare Pages Functions for Zendesk readiness testing, incremental synchronization, and daily operations aggregation.

## Pages endpoints

```text
POST /api/zendesk-test
POST /api/sync-zendesk
POST /api/sync-zendesk-events
POST /api/refresh-operations-metrics
```

All endpoints use the configured bearer synchronization secret.

## Required Pages settings

```text
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_SYNC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Optional variables:

```text
ZENDESK_INITIAL_START_TIME
ZENDESK_SYNC_PAGE_SIZE
ZENDESK_EVENT_INITIAL_START_TIME
ZENDESK_EVENT_PAGE_SIZE
OPERATIONS_TIME_ZONE
```

Recommended production values:

```text
ZENDESK_SYNC_PAGE_SIZE=25
ZENDESK_EVENT_PAGE_SIZE=100
OPERATIONS_TIME_ZONE=America/New_York
```

## Resource-safe synchronization model

The synchronization is divided into two streams.

### Ticket snapshot stream

```text
POST /api/sync-zendesk
```

This endpoint reads one cursor-based ticket page and stores ticket-created and first-response records.

### Ticket change stream

```text
POST /api/sync-zendesk-events
```

This endpoint reads one bounded page from Zendesk's incremental ticket-event export. It stores assignment, priority, status, solved, reopened, and closed changes.

### Daily operations aggregation

```text
POST /api/refresh-operations-metrics
```

This endpoint refreshes `daily_operations_metrics` after event synchronization is complete. Scheduled calls recalculate the most recent 30 days so late events and reopened-ticket changes are incorporated.

## Scheduled Worker

The existing Worker deployment remains:

```text
socialloop-zendesk-health-cron
```

The name is retained to avoid replacing the existing Cloudflare Worker, but its function is now scheduled production synchronization and aggregation.

The Worker runs through an hourly UTC Cron Trigger and begins work only when the local time in `America/New_York` is **9:00 AM Eastern**. This was changed from **12:00 noon Eastern**.

At 9:00 AM it calls both streams in round-robin order:

```text
POST /api/sync-zendesk
POST /api/sync-zendesk-events
```

It continues while either endpoint returns `hasMore: true`, waits seven seconds between Zendesk requests, and stops when both streams reach `endOfStream: true`.

Only after both streams complete, it calls:

```text
POST /api/refresh-operations-metrics
```

If either stream remains partial, the Worker does not publish refreshed daily aggregates.

The Worker has safety boundaries:

```text
maximum Zendesk requests: 100
maximum synchronization runtime: 13 minutes
Cloudflare scheduled invocation wall-time boundary: 15 minutes
```

All successfully processed pages commit their cursor or `start_time`, so an incomplete run resumes from saved state on the next schedule.

## Required Worker secrets

```text
PAGES_BASE_URL
ZENDESK_SYNC_SECRET
```

`PAGES_BASE_URL` must be the final non-redirecting production Pages origin. The Worker secret must match the Pages Function secret.

## Deployment

GitHub Actions deploys the Worker through:

```text
.github/workflows/deploy-zendesk-health-worker.yml
```

The workflow validates secrets, runs the Zendesk and Step 3 tests, deploys the existing Worker, and verifies that its status endpoint reports daily operations metrics at 9:00 AM Eastern.

## Tests

```bash
npm run test:zendesk-integration
npm run test:phase3-step2
npm run test:phase3-step3
```
