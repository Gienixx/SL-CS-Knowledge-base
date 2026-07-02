# Phase 3 Step 6 — Response Times Only

This installation uses Zendesk ticket events for first-response and resolution-time reporting. Zendesk SLA policies are not required.

## Apply

Run this Supabase migration:

`supabase/migrations/2026070201_phase3_step6_sla_response_dashboard.sql`

Then run:

`supabase/verification/phase3_step6_response_times_check.sql`

Open `/response-times.html` and compare several known tickets against Zendesk.

## Keep disabled

Leave `ZENDESK_SLA_SYNC_ENABLED` unset. Do not call `/api/sync-zendesk-sla`. The optional SLA readiness migration is not required for this installation.
