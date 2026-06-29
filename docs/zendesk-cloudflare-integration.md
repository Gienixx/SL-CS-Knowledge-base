# Zendesk integration on Cloudflare

This repository contains protected Cloudflare Pages Functions for Zendesk readiness testing and incremental ticket-event synchronization.

## Pages endpoints

```text
POST /api/zendesk-test
POST /api/sync-zendesk
```

Both endpoints require:

```text
Authorization: Bearer ZENDESK_SYNC_SECRET
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

Optional Step 2 variables:

```text
ZENDESK_INITIAL_START_TIME
ZENDESK_SYNC_PAGE_SIZE
```

`ZENDESK_API_TOKEN`, `ZENDESK_SYNC_SECRET`, and `SUPABASE_SERVICE_ROLE_KEY` must be encrypted secrets. These values are read only inside Pages Functions through `context.env`.

## Manual connection test

```bash
curl -X POST "https://YOUR_PAGES_DOMAIN/api/zendesk-test" \
  -H "Authorization: Bearer YOUR_ZENDESK_SYNC_SECRET" \
  -H "Accept: application/json"
```

A successful result should report `success: true`, `supabaseConnected: true`, and readiness values for ticket events, SLA, and CSAT.

The readiness endpoint never returns ticket subjects, descriptions, comments, requester data, API tokens, or service-role credentials.

## Scheduled health-check Worker

The Worker project is located at:

```text
workers/zendesk-health/index.js
workers/zendesk-health/wrangler.toml
```

The Cron Trigger executes hourly in UTC, but the Worker calls the Pages endpoint only when the local time in `America/New_York` is **9:00 AM Eastern**.

This was changed from **12:00 noon Eastern to 9:00 AM Eastern**. The IANA timezone automatically applies EST or EDT depending on daylight-saving time.

The Worker currently calls:

```text
POST /api/zendesk-test
```

Keep it on the health endpoint until the Phase 3 Step 2 migration is applied and an initial manual `/api/sync-zendesk` backfill completes successfully.

## Required Worker secrets

```text
PAGES_BASE_URL
ZENDESK_SYNC_SECRET
```

`PAGES_BASE_URL` is the production Pages origin without a trailing path. The Worker `ZENDESK_SYNC_SECRET` must exactly match the Pages secret.

## Automated GitHub deployment

The deployment workflow is:

```text
.github/workflows/deploy-zendesk-health-worker.yml
```

Required encrypted GitHub Actions secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
PAGES_BASE_URL
ZENDESK_SYNC_SECRET
```

The workflow runs the Zendesk tests, deploys `socialloop-zendesk-health-cron`, uploads the Worker secrets, applies the hourly Cron Trigger, verifies the Worker endpoint, and removes the temporary runner secret file.

Cron Trigger updates can take several minutes to propagate in Cloudflare.

## Step 2 synchronization behavior

`POST /api/sync-zendesk` processes one bounded incremental ticket page per request. Ticket audits are loaded with Zendesk cursor pagination using:

```text
page[size]=100
page[after]=<cursor>
include_boundary_indicators=true
```

Zendesk does not support audit pagination for archived tickets. When pagination metadata is unavailable and a full 100-record page is returned, the endpoint logs a sanitized warning because the archived audit history may be incomplete.

The synchronization cursor advances only after successful event writes. Duplicate event imports are prevented by the unique `source_event_id` key.

## Tests

```bash
npm run test:zendesk-integration
npm run test:phase3-step2
```
