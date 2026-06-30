# Phase 3 Step 2 — Ticket-event storage

Phase 3 Step 2 adds normalized Zendesk ticket-event storage and protected incremental synchronization.

## Database objects

Apply:

```text
supabase/migrations/20260627_phase3_step2_ticket_event_storage.sql
```

The migration creates:

```text
ticket_events
zendesk_sync_state
zendesk_sync_runs
```

`ticket_events` contains reporting-safe lifecycle data only. Ticket subjects, descriptions, comments, attachments, requester email addresses, and message content are not imported.

Supported event types:

```text
created
assigned
first_response
status_changed
priority_changed
solved
reopened
closed
```

The schema also reserves `sla_breached` and `csat_rating` for later Phase 3 work.

Every event has an immutable `source_event_id`. A unique constraint and conflict-ignore inserts prevent duplicate events when pages overlap or are retried.

## Cursor and lease state

`zendesk_sync_state` stores the ticket cursor, event-stream Unix start time, latest event timestamp, last successful run, and synchronization lease.

Service-role-only database functions provide atomic state changes:

```text
acquire_zendesk_sync_lock
release_zendesk_sync_lock
advance_zendesk_sync_state
```

A concurrent request receives a `409 zendesk_sync_locked` response while a valid lease exists.

## Synchronization endpoints

### Ticket snapshots

```text
POST /api/sync-zendesk
```

Each request processes one bounded cursor page from Zendesk's incremental ticket export. It stores ticket-created events and first-response records derived from Zendesk ticket metrics.

### Ticket lifecycle changes

```text
POST /api/sync-zendesk-events
```

Each request processes one bounded time-based page from Zendesk's incremental ticket-event export. It stores assignment, priority, status, solved, reopened, and closed events.

The corrected event normalizer supports the observed Zendesk child-event payload:

```text
event_type = Change
status
priority
assignee_id
previous_value
```

Both endpoints:

1. Validate server configuration and bearer authorization.
2. Acquire their independent stream lease.
3. Create a `zendesk_sync_runs` record.
4. Retrieve one bounded Zendesk page.
5. Normalize reporting-safe events.
6. Insert only unseen `source_event_id` values.
7. Advance the saved cursor or `start_time` only after successful writes.
8. Complete the run record and release the lease.

A successful response includes:

```json
{
  "success": true,
  "stream": "ticket_events",
  "eventsSeen": 8,
  "eventsImported": 7,
  "duplicateEvents": 1,
  "endOfStream": false,
  "hasMore": true
}
```

## Optional Pages variables

```text
ZENDESK_INITIAL_START_TIME
ZENDESK_SYNC_PAGE_SIZE
ZENDESK_EVENT_INITIAL_START_TIME
ZENDESK_EVENT_PAGE_SIZE
```

Recommended production page sizes after the initial backfill:

```text
ZENDESK_SYNC_PAGE_SIZE=25
ZENDESK_EVENT_PAGE_SIZE=100
```

## Verification

Run:

```text
supabase/verification/phase3_step2_ticket_event_check.sql
```

Expected results:

```text
required_tables                 PASS
source_event_id_uniqueness      PASS
event_integrity                 PASS
row_level_security              PASS
ticket_cursor_state             PASS
```

Operational completion additionally requires:

```text
tickets stream:       last_success_at populated, no active lease
ticket_events stream: last_success_at populated, no active lease
ticket_event rows:    assignment/status/priority lifecycle rows present
```

## Access model

- Authenticated browser users have read-only access to `ticket_events`.
- Anonymous users have no access.
- `zendesk_sync_state` and `zendesk_sync_runs` remain server-only.
- Only service-role-backed Pages Functions can write events or advance synchronization state.

## Scheduled synchronization

The Cloudflare Worker now runs both streams at **9:00 AM Eastern**, changed from **12:00 noon Eastern**.

The Worker alternates between the ticket and ticket-event streams while either has more pages, waits seven seconds between requests, and stops when both report `endOfStream: true`. It also enforces request and runtime limits so successful progress is preserved even when a daily run cannot finish every page.

## Tests

```bash
npm run test:phase3-step2
npm run test:zendesk-integration
```
