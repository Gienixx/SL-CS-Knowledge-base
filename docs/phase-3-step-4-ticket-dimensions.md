# Phase 3 Step 4 — Zendesk ticket dimensions

Phase 3 Step 4 adds a server-only current profile for the four Zendesk dimensions that are not reliably present on immutable lifecycle events:

```text
app
platform
country
driver
```

The profile is maintained from full Zendesk ticket snapshots. Historical `ticket_events` rows are not updated or rewritten.

## Database migration

Apply:

```text
supabase/migrations/20260701_phase3_step4_ticket_dimension_profiles.sql
```

The migration creates:

```text
ticket_dimension_profiles
upsert_ticket_dimension_profiles(jsonb)
```

It also creates the independent synchronization state row:

```text
ticket_dimensions_backfill
```

## Security model

`ticket_dimension_profiles` is server-only:

- row-level security is enabled;
- `anon` and `authenticated` receive no table privileges;
- only `service_role` can read or maintain profiles;
- only `service_role` can execute the upsert function;
- browser code cannot run the historical backfill.

The table represents current ticket dimensions. It is intentionally separate from the append-only `ticket_events` lifecycle history.

## Required Cloudflare environment variables

Configure the numeric Zendesk custom-field IDs:

```text
ZENDESK_APP_CUSTOM_FIELD_ID
ZENDESK_PLATFORM_CUSTOM_FIELD_ID
ZENDESK_COUNTRY_CUSTOM_FIELD_ID
ZENDESK_DRIVER_CUSTOM_FIELD_ID
```

The shorter aliases below are also accepted, but the `*_CUSTOM_FIELD_ID` names are preferred:

```text
ZENDESK_APP_FIELD_ID
ZENDESK_PLATFORM_FIELD_ID
ZENDESK_COUNTRY_FIELD_ID
ZENDESK_DRIVER_FIELD_ID
```

The existing Zendesk and Supabase server variables are also required:

```text
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_SYNC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Optional backfill controls:

```text
ZENDESK_DIMENSION_INITIAL_START_TIME
ZENDESK_DIMENSION_PAGE_SIZE
```

`ZENDESK_DIMENSION_INITIAL_START_TIME` is a Unix timestamp in seconds. When it is absent, the endpoint defaults to a 365-day lookback. `ZENDESK_DIMENSION_PAGE_SIZE` defaults to 50 and is capped at 100.

## Historical backfill endpoint

```text
POST /api/backfill-zendesk-ticket-dimensions
Authorization: Bearer <ZENDESK_SYNC_SECRET>
```

The endpoint:

1. verifies the existing synchronization bearer secret;
2. requires all four custom-field IDs;
3. acquires an independent server-side lease;
4. reads one page from Zendesk incremental ticket snapshots;
5. normalizes and upserts current dimension profiles;
6. advances the dedicated cursor only after the database write succeeds.

Call the endpoint repeatedly while the response contains:

```json
{
  "hasMore": true
}
```

Stop when:

```json
{
  "endOfStream": true,
  "hasMore": false
}
```

The response exposes counts and cursor progress but never returns the synchronization secret or raw ticket contents.

## Ongoing maintenance

After the migration is applied and at least one dimension field ID is configured, the existing endpoint:

```text
POST /api/sync-zendesk
```

also upserts ticket-dimension profiles from every future Zendesk snapshot page. The response adds:

```text
dimensionFieldsConfigured
dimensionProfilesSeen
dimensionProfilesUpserted
```

This keeps the profile current without changing the event import contract.

## Stale-write protection

The database upsert ignores an older snapshot when the stored profile has a newer `source_updated_at` value. This prevents a historical backfill from overwriting a more recent scheduled snapshot.

## Verification

After the migration and first backfill page, run:

```text
supabase/verification/phase3_step4_ticket_dimension_check.sql
```

Expected checks:

```text
required_objects       PASS
profile_integrity      PASS
row_level_security     PASS
server_only_access     PASS
backfill_state         PASS
dimension_coverage     PASS
```

`dimension_coverage` fails when no profiles have been imported yet. It reports the populated counts for app, platform, country, and driver so incorrect field mappings are visible immediately.

## Tests

```bash
npm run test:phase3-step4
npm run test:zendesk-integration
```

## Manual production sequence

1. Apply the Step 4 Supabase migration.
2. Add the four Zendesk custom-field IDs to Cloudflare Pages production variables.
3. Redeploy the Pages project so Functions receive the new variables.
4. Call the protected backfill endpoint until `hasMore` is `false`.
5. Run the Step 4 verification SQL.
6. Confirm the normal scheduled `/api/sync-zendesk` response reports four configured fields.
