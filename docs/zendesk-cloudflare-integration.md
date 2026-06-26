# Zendesk integration on Cloudflare

This repository now contains a protected Cloudflare Pages Function that verifies:

- Zendesk API-token authentication
- incremental ticket-export access
- ticket-metric inclusion
- ticket-audit access when a recent ticket is available
- ticket-metric-event access for SLA reporting
- satisfaction-rating access for CSAT reporting
- the existing Supabase service-role connection

The endpoint is deployed automatically with the Pages project at:

```text
POST /api/zendesk-test
```

## Required Pages variables and secrets

The Pages project must contain:

```text
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_SYNC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

`ZENDESK_API_TOKEN`, `ZENDESK_SYNC_SECRET`, and
`SUPABASE_SERVICE_ROLE_KEY` must be encrypted secrets. These values are read only
inside Pages Functions through `context.env`.

## Manual connection test

After the Pages deployment completes, run:

```bash
curl -X POST "https://YOUR_PAGES_DOMAIN/api/zendesk-test" \
  -H "Authorization: Bearer YOUR_ZENDESK_SYNC_SECRET" \
  -H "Accept: application/json"
```

A successful response has this general shape:

```json
{
  "success": true,
  "integration": "zendesk",
  "supabaseConnected": true,
  "authenticatedRole": "admin",
  "access": {
    "tickets": "available",
    "ticketMetrics": "available",
    "ticketAudits": "available",
    "ticketMetricEvents": "available",
    "customerSatisfaction": "available"
  },
  "readyForTicketEventImport": true,
  "readyForSlaImport": true,
  "readyForCsatImport": true
}
```

`ticketMetrics` can be `not_observed_in_sample` when the one-ticket sample has no
metric set. `ticketAudits` can be `not_tested_no_recent_ticket` when the preceding
seven days contain no tickets. CSAT can be unavailable when the Zendesk account does
not use legacy satisfaction ratings.

The endpoint never returns ticket subjects, descriptions, comments, requester data,
the API token, or the service-role key.

## Scheduled health check Worker

The repository includes:

```text
workers/zendesk-health-cron.js
wrangler.zendesk-health-cron.toml
```

Cloudflare Cron Triggers use UTC. The Worker runs hourly but calls the Pages endpoint
only when the local time in `America/New_York` is 12:00, which keeps the check at noon
through daylight-saving changes.

Set the Worker-only values. The value of `ZENDESK_SYNC_SECRET` must match the Pages
secret exactly.

```bash
npx wrangler secret put PAGES_BASE_URL \
  --config wrangler.zendesk-health-cron.toml

npx wrangler secret put ZENDESK_SYNC_SECRET \
  --config wrangler.zendesk-health-cron.toml
```

For `PAGES_BASE_URL`, enter the production origin without a trailing path, for example:

```text
https://support.example.com
```

Deploy the Worker:

```bash
npx wrangler deploy --config wrangler.zendesk-health-cron.toml
```

After deployment, confirm that the Worker has this trigger:

```text
0 * * * *
```

Review the Worker logs after noon Eastern. A successful run logs only sanitized
readiness booleans.

## Current boundary

This setup enables and continuously verifies the Zendesk connection. It does not yet
write Zendesk ticket events into Supabase. Phase 3 Step 2 must create the normalized
`ticket_events` storage and cursor state before a production ingestion endpoint is
enabled. Scheduling ingestion before that schema exists would create an unsafe or
non-idempotent import process.

## Tests

Run:

```bash
npm run test:zendesk-integration
```
