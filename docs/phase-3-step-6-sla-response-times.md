# Phase 3 Step 6 — SLA and response-time dashboards

Phase 3 Step 6 adds a separate authenticated operational dashboard for trusted Zendesk first-response, resolution-time, and SLA breach reporting.

## Source boundary

The overview dashboard remains on the synchronized Google Sheet snapshot. The new `response-times.html` page does not use the workbook and does not estimate advanced metrics.

Authoritative sources:

- first response: Zendesk ticket metrics normalized as `first_response` ticket events;
- resolution time: normalized ticket creation and final lifecycle state;
- SLA breaches: Zendesk incremental ticket metric events normalized as `sla_breached` events.

SLA values remain unavailable until the SLA metric-event stream has completed at least one successful synchronization. A missing SLA stream is never displayed as zero.

## Database migration

Apply:

```text
supabase/migrations/20260702_phase3_step6_sla_response_dashboard.sql
```

It creates:

```text
public.get_sla_response_dashboard(date,date,text,text,text,text,text,text,text,text)
```

The RPC supports:

- date ranges up to 366 days;
- App, Platform, Country, Concern, Agent, Priority, and Channel filters;
- average, median, and 90th-percentile response and resolution values;
- daily response and resolution trends;
- response and resolution duration buckets;
- trusted SLA breach totals and metric breakdowns after the SLA stream is active;
- filter options from normalized Zendesk ticket dimensions.

## SLA event synchronization

Protected endpoint:

```text
POST /api/sync-zendesk-sla
Authorization: Bearer <ZENDESK_SYNC_SECRET>
```

Source endpoint:

```text
GET /api/v2/incremental/ticket_metric_events.json
```

Only non-deleted events with `type=breach` are imported. Ticket content and requester information are not stored.

Optional Cloudflare Pages variable:

```text
ZENDESK_SLA_INITIAL_START_TIME
```

Scheduled SLA ingestion is feature-gated in the Worker:

```text
ZENDESK_SLA_SYNC_ENABLED=true
```

Do not enable the flag until Zendesk SLA policies are active and the API user can access ticket metric events.

## Dashboard behavior

The dashboard provides:

- average, median, and 90th-percentile first-response time;
- average business-hours first response;
- average, median, and 90th-percentile resolution time;
- SLA breach and affected-ticket totals;
- daily trend, duration distributions, SLA metric breakdown, and daily table;
- explicit unavailable states when trusted metrics are not ready.

## Verification

Run:

```text
supabase/verification/phase3_step6_sla_response_check.sql
npm run test:phase3-step6
npm run test:phase3-step5
npm run test:phase3-step4
```

Expected SQL checks:

```text
authenticated_execution          PASS
sla_event_type_reserved          PASS
sla_response_dashboard_rpc       PASS
ticket_metric_event_stream_state PASS
```

## Manual production sequence

1. Confirm Zendesk SLA policies are enabled and the API user can read ticket metric events.
2. Apply `supabase/migrations/20260702_phase3_step6_sla_response_dashboard.sql` in the Supabase SQL Editor.
3. Run `supabase/verification/phase3_step6_sla_response_check.sql` and confirm all four checks return `PASS`.
4. Confirm the latest Cloudflare Pages deployment contains `/api/sync-zendesk-sla` and `response-times.html`.
5. With `ZENDESK_SLA_SYNC_ENABLED` still disabled, call `/api/sync-zendesk-sla` manually with the existing sync secret until `hasMore` is false and `endOfStream` is true.
6. Rerun the verification SQL and confirm `ticket_metric_events.last_success_at` is populated and the stream status is `READY`.
7. Open the SLA & Response Times page and validate a representative date range against Zendesk Explore or a known ticket sample.
8. Only after validation, set `ZENDESK_SLA_SYNC_ENABLED=true` on the Zendesk health Worker and redeploy the Worker.
9. Confirm the next scheduled 9:00 AM Eastern run includes the `ticket_metric_events` stream and completes the operations-metrics refresh.

No new browser-side secret is required. Do not add Zendesk credentials or the sync secret to client JavaScript.
