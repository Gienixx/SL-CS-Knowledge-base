# Phase 3 Step 1 — Advanced data-source confirmation

## Decision

Phase 3 operational metrics will use **Zendesk Support API as the authoritative source**.

The existing Google workbook remains the source for the Phase 1 and Phase 2 daily
summary datasets only. It does not contain the ticket-level timestamps, field-change
history, SLA events, or rating records required for reliable operational analytics.
Supabase remains the normalized storage and reporting destination, not the original
source of ticket events.

Response-time, ticket-age, SLA, and event metrics must not be calculated from the
existing workbook aggregates.

## Confirmed source contract

| Metric | Authoritative resource | Source fields or events | Rule |
| --- | --- | --- | --- |
| First-response time | Zendesk ticket metrics | `reply_time_in_minutes.calendar`, `reply_time_in_minutes.business` | Use Zendesk's metric value. |
| Full-resolution time | Zendesk ticket metrics | `full_resolution_time_in_minutes.calendar`, `full_resolution_time_in_minutes.business` | Use Zendesk's latest full-resolution metric. |
| Ticket age | Zendesk tickets | `created_at`, `status` | Active age is current time minus creation time; resolved age uses the chosen resolution timestamp. |
| SLA breaches | Zendesk ticket metric events | `type=breach`, `metric`, `time`, `deleted`, `sla` | Count only non-deleted breach events. |
| Assignee | Zendesk tickets and audits | `assignee_id`, assignment field changes | Ticket gives current assignee; audits give history. |
| Priority | Zendesk tickets and audits | `priority`, priority field changes | Ticket gives current priority; audits give history. |
| Ticket status changes | Zendesk ticket audits | audit `created_at` and status `Change` events | Normalize each status change as an event. |
| Ticket creation timestamp | Zendesk tickets | `created_at` | Store unchanged in UTC. |
| Ticket resolution timestamp | Zendesk ticket metrics and audits | `solved_at`, solved status changes | Metric gives latest solution; audits preserve every solve/reopen cycle. |
| Reopen timestamp | Zendesk ticket audits | solved-to-working status changes | Use the containing audit timestamp. |
| Channel | Zendesk tickets | `via.channel` | Keep raw value and a normalized reporting key. |
| Customer satisfaction | Zendesk satisfaction ratings and ticket rating object | score, comment, reason, timestamps, ticket id | Calculate CSAT only from eligible submitted responses. |

The machine-readable version of this contract is in:

```text
config/phase3-advanced-data-sources.js
```

## Required Zendesk endpoints

```text
GET /api/v2/incremental/tickets/cursor
GET /api/v2/tickets/{ticket_id}/audits
GET /api/v2/incremental/ticket_metric_events
GET /api/v2/satisfaction_ratings
```

Use `include=metric_sets` with the incremental ticket export when supported by the
account and response shape. Ticket audit retrieval is required for exact assignment,
priority, status, solved, and reopened history.

## Server-side credentials

The future Zendesk ingestion function will require these server-side environment
variables:

```text
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
```

They must be stored in Cloudflare environment secrets and must never be included in
browser JavaScript, committed files, logs, or API responses.

## Availability gates

The source is selected, but live ingestion must not be treated as ready until these
checks pass:

1. The Zendesk credentials can authenticate from a server-side test function.
2. The API user is allowed to run incremental ticket exports.
3. Ticket metrics are returned for representative solved tickets.
4. Ticket audits expose status and assignee change events.
5. SLA policies are enabled before SLA breach reporting is activated.
6. CSAT is enabled before customer-satisfaction reporting is activated.
7. Source timestamps are returned in UTC and can be persisted without truncation.
8. A sample extraction contains no ticket comment bodies or other unnecessary personal content.

Until those checks pass, Phase 3 response-time and SLA values must remain unavailable
rather than being approximated.

## Extraction boundary

Phase 3 ingestion should collect only the fields needed for operational reporting.
Ticket subjects, descriptions, comment bodies, attachments, requester email addresses,
and other message content are outside the initial analytics scope.

## Step 1 acceptance test

Run:

```bash
npm run test:phase3-step1
```

Step 1 is accepted when:

- all twelve advanced metrics have exactly one authoritative mapping;
- every mapping points to a registered Zendesk endpoint;
- the workbook is explicitly non-authoritative for advanced metrics;
- required environment-variable names are documented;
- the live Zendesk availability gates are completed before Step 2 ingestion is enabled.
