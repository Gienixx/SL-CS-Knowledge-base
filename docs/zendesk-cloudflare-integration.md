# Zendesk integration on Cloudflare

This repository contains a protected Cloudflare Pages Function that verifies:

- Zendesk API-token authentication
- incremental ticket-export access
- ticket-metric inclusion
- ticket-audit access when a recent ticket is available
- ticket-metric-event access for SLA reporting
- satisfaction-rating access for CSAT reporting
- the existing Supabase service-role connection

The endpoint is deployed with the Pages project at:

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

## Scheduled health-check Worker

The self-contained Worker project is located at:

```text
workers/zendesk-health/index.js
workers/zendesk-health/wrangler.toml
```

The Worker has an hourly UTC Cron Trigger but calls the Pages endpoint only when the
local time in `America/New_York` is 12:00. This keeps the health check at noon through
daylight-saving changes.

The Wrangler configuration declares these required Worker secrets:

```text
PAGES_BASE_URL
ZENDESK_SYNC_SECRET
```

`PAGES_BASE_URL` is the production Pages origin without a trailing path. The Worker
`ZENDESK_SYNC_SECRET` must exactly match the Pages secret.

## Automated GitHub deployment

The deployment workflow is:

```text
.github/workflows/deploy-zendesk-health-worker.yml
```

Add these four encrypted repository secrets under:

```text
GitHub repository > Settings > Secrets and variables > Actions
```

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
PAGES_BASE_URL
ZENDESK_SYNC_SECRET
```

The Cloudflare API token should be scoped to the relevant account and granted the
Workers edit permission. Never commit any of these values.

The workflow:

1. runs the Zendesk integration tests;
2. creates an ephemeral secrets file on the GitHub runner;
3. deploys `socialloop-zendesk-health-cron` with Wrangler;
4. uploads the two Worker secrets alongside the code;
5. applies the `0 * * * *` Cron Trigger;
6. deletes the ephemeral secrets file.

It runs automatically when the Worker, Zendesk server integration, or deployment
workflow changes on `main`. It can also be started manually from the GitHub Actions
tab.

Cron Trigger updates can take several minutes to propagate in Cloudflare.

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
