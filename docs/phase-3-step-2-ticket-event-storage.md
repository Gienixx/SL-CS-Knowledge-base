# Phase 3 Step 2 — Ticket-event storage

Phase 3 Step 2 adds normalized Zendesk ticket-event storage and a protected incremental synchronization endpoint.

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

Initial event types:

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

Every event has an immutable `source_event_id`. A unique constraint and conflict-ignore inserts prevent duplicate events when a page is retried.

## Cursor and lease state

`zendesk_sync_state` stores the export cursor, initial Unix start time, latest event timestamp, last successful run, and temporary synchronization lease.

Service-role-only database functions provide atomic state changes:

```text
acquire_zendesk_sync_lock
release_zendesk_sync_lock
advance_zendesk_sync_state
```

A concurrent request receives a `409 zendesk_sync_locked` response while a valid lease exists.

## Synchronization endpoint

```text
POST /api/sync-zendesk
```

The endpoint uses the same bearer authorization value as the existing Zendesk health endpoint.

Each call processes one bounded cursor page. The default ticket page size is 25 and the maximum is 50 because each ticket may require a separate audit request.

Processing order:

1. Validate Zendesk and Supabase server configuration.
2. Validate the synchronization authorization header.
3. Acquire the database lease.
4. Create a `zendesk_sync_runs` record.
5. Fetch one incremental ticket page with metric sets.
6. Retrieve ticket audits.
7. Normalize lifecycle and first-response events.
8. Insert only unseen source event IDs.
9. Advance the cursor only after successful writes.
10. Complete the run record and release the lease.

A successful response includes:

```json
{
  "success": true,
  "ticketsProcessed": 25,
  "eventsSeen": 83,
  "eventsImported": 83,
  "duplicateEvents": 0,
  "endOfStream": false,
  "hasMore": true
}
```

Call the endpoint again while `hasMore` is true. Every successful request resumes from the committed cursor.

## Optional Pages variables

```text
ZENDESK_INITIAL_START_TIME
ZENDESK_SYNC_PAGE_SIZE
```

`ZENDESK_INITIAL_START_TIME` is a Unix timestamp in seconds and is used only before a cursor exists. When omitted, the first request starts seven days before the request time.

`ZENDESK_SYNC_PAGE_SIZE` defaults to 25 and is capped at 50.

## Verification

After applying the migration, run:

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

Then send an authorized POST request to `/api/sync-zendesk`. Repeat until `endOfStream` becomes true for the initial backfill.

## Access model

- Authenticated browser users have read-only access to `ticket_events`.
- Anonymous users have no access.
- `zendesk_sync_state` and `zendesk_sync_runs` remain server-only.
- Only the service-role-backed Pages endpoint can write events or advance the cursor.

## Scheduling boundary

Keep the Worker pointed at `/api/zendesk-test` until the migration is applied and one manual `/api/sync-zendesk` request succeeds. The Worker can then be switched to incremental event synchronization.

## Tests

```bash
npm run test:phase3-step2
```
