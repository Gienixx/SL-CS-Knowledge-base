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

Recommended initial values:

```text
ZENDESK_SYNC_PAGE_SIZE=5
ZENDESK_EVENT_PAGE_SIZE=100
```

## Resource-safe synchronization model

The synchronization is intentionally divided into two streams.

### Ticket snapshot stream

```text
POST /api/sync-zendesk
```

This endpoint reads one cursor-based ticket page and stores only ticket-created and first-response records. It does not request every audit page for each ticket.

### Ticket change stream

```text
POST /api/sync-zendesk-events
```

This endpoint reads one bounded page from Zendesk's incremental ticket-event export. It stores assignment, priority, status, solved, reopened, and closed changes. Existing event identifiers use the audit identifier when Zendesk provides one, preventing duplicates with events imported by an earlier version.

The event stream is time-based. Each successful request saves the response `end_time` as the next `start_time` under the `ticket_events` stream key in `zendesk_sync_state`.

## Why the streams were separated

The previous implementation loaded all available audit pages for every ticket in one Pages Function request. A single high-activity ticket could exceed Cloudflare CPU or memory limits even when the ticket page size was one. The split design keeps each request bounded and avoids per-ticket historical audit traversal.

## Schedule

The health check runs at **9:00 AM Eastern**, changed from **12:00 noon Eastern**. The Worker evaluates `America/New_York`, so the local hour remains 9:00 through EST and EDT changes.

The Worker currently calls:

```text
POST /api/zendesk-test
```

Keep it on the health endpoint until both initial synchronization streams complete and are verified.

## Tests

```bash
npm run test:zendesk-integration
npm run test:phase3-step2
```
