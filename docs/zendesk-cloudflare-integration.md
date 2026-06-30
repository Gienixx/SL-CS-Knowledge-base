# Zendesk integration on Cloudflare

This repository contains protected Cloudflare Pages Functions for Zendesk readiness testing and incremental synchronization.

## Pages endpoints

```text
POST /api/zendesk-test
POST /api/sync-zendesk
POST /api/sync-zendesk-events
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
```

Recommended production values after the initial backfill:

```text
ZENDESK_SYNC_PAGE_SIZE=25
ZENDESK_EVENT_PAGE_SIZE=100
```

## Resource-safe synchronization model

The synchronization is divided into two streams.

### Ticket snapshot stream

```text
POST /api/sync-zendesk
```

This endpoint reads one cursor-based ticket page and stores ticket-created and first-response records. It does not request every audit page for each ticket.

### Ticket change stream

```text
POST /api/sync-zendesk-events
```

This endpoint reads one bounded page from Zendesk's incremental ticket-event export. It stores assignment, priority, status, solved, reopened, and closed changes.

The event stream is time-based. Each successful request saves the response `end_time` as the next `start_time` under the `ticket_events` stream key in `zendesk_sync_state`.

## Scheduled Worker

The existing Worker deployment remains:

```text
socialloop-zendesk-health-cron
```

The name is retained to avoid replacing the existing Cloudflare Worker, but its function is now scheduled production synchronization.

The Worker runs through an hourly UTC Cron Trigger and begins work only when the local time in `America/New_York` is **9:00 AM Eastern**. This was changed from **12:00 noon Eastern**.

At 9:00 AM it calls both streams in round-robin order:

```text
POST /api/sync-zendesk
POST /api/sync-zendesk-events
```

It continues while either endpoint returns `hasMore: true`, waits seven seconds between requests to remain below Zendesk's incremental-export request limit, and stops when both streams reach `endOfStream: true`.

The Worker has safety boundaries:

```text
maximum requests: 100
maximum synchronization runtime: 13 minutes
Cloudflare scheduled invocation wall-time boundary: 15 minutes
```

If the safety boundary is reached before both streams finish, the Worker logs a partial result. All successful pages have already committed their cursor or `start_time`, so the next scheduled run resumes from the saved state.

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

The workflow validates secrets, runs the Zendesk synchronization tests, deploys the existing Worker, and verifies that the public Worker status endpoint reports the 9:00 AM Eastern schedule.

## Tests

```bash
npm run test:zendesk-integration
npm run test:phase3-step2
```
