# Phase 3 Step 4 — Zendesk ticket dimensions

Phase 3 Step 4 maintains a server-only current profile for Zendesk dimensions that are not reliably present on immutable lifecycle events.

Required dimensions:

```text
app
platform
country
concern
```

`concern` maps to the Zendesk **Concerns** ticket field. It replaces the earlier `driver` dimension name.

The profile is maintained from full Zendesk ticket snapshots. Historical `ticket_events` rows are not updated or rewritten.

## Database migrations

For a fresh database, apply:

```text
supabase/migrations/20260701_phase3_step4_ticket_dimension_profiles.sql
```

For a database where the original Step 4 migration was already applied, additionally apply:

```text
supabase/migrations/20260701_phase3_step4b_concern_dimension.sql
```

The upgrade migration:

- renames the stored `driver_key` field to `concern_key`;
- replaces the profile-upsert function so it accepts `concern_key`;
- migrates stored field-ID metadata from `driver` to `concern`;
- creates a generated, read-only `driver_key` compatibility alias;
- resets the independent dimension-backfill cursor so the Concern values can be reimported.

The compatibility alias prevents the existing Step 4 global dashboard RPC from breaking. New ingestion and verification use `concern_key` as the authoritative field.

## Database objects

The migrations maintain:

```text
ticket_dimension_profiles
upsert_ticket_dimension_profiles(jsonb)
ticket_dimensions_backfill
```

## Security model

`ticket_dimension_profiles` is server-only:

- row-level security is enabled;
- `anon` and `authenticated` receive no table privileges;
- only `service_role` can read or maintain profiles;
- only `service_role` can execute the upsert function;
- browser code cannot run the historical backfill.

The table represents current ticket dimensions. It remains separate from the append-only `ticket_events` lifecycle history.

## Required Cloudflare environment variables

Configure these numeric Zendesk custom-field IDs:

```text
ZENDESK_APP_CUSTOM_FIELD_ID
ZENDESK_PLATFORM_CUSTOM_FIELD_ID
ZENDESK_COUNTRY_CUSTOM_FIELD_ID
ZENDESK_CONCERN_CUSTOM_FIELD_ID
```

The shorter aliases below are also accepted:

```text
ZENDESK_APP_FIELD_ID
ZENDESK_PLATFORM_FIELD_ID
ZENDESK_COUNTRY_FIELD_ID
ZENDESK_CONCERN_FIELD_ID
```

Do not use these obsolete variables for the Concerns field:

```text
ZENDESK_DRIVER_CUSTOM_FIELD_ID
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

`ZENDESK_DIMENSION_INITIAL_START_TIME` is a Unix timestamp in seconds. When absent, the endpoint defaults to a 365-day lookback. `ZENDESK_DIMENSION_PAGE_SIZE` defaults to 50 and is capped at 100.

## Historical backfill endpoint

```text
POST /api/backfill-zendesk-ticket-dimensions
Authorization: Bearer <ZENDESK_SYNC_SECRET>
```

The endpoint uses the independent synchronization state:

```text
ticket_dimensions_backfill
```

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

The Step 4b migration resets this cursor automatically. The next backfill therefore starts from `ZENDESK_DIMENSION_INITIAL_START_TIME`, or from the default 365-day lookback when that variable is absent.

The endpoint response exposes counts and cursor progress but never returns the synchronization secret or raw ticket contents.

## Ongoing maintenance

The existing endpoint:

```text
POST /api/sync-zendesk
```

continues to upsert ticket-dimension profiles from future Zendesk snapshot pages. The normalizer now emits:

```text
app_key
platform_key
country_key
concern_key
```

The generated `driver_key` column mirrors `concern_key` only for compatibility with the currently deployed dashboard RPC.

## Stale-write protection

The database upsert ignores an older snapshot when the stored profile has a newer `source_updated_at` value. This prevents a historical backfill from overwriting a more recent scheduled snapshot.

## Verification

After applying the Step 4b migration and completing at least one backfill page, run:

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
compatibility_alias    PASS
dimension_coverage     PASS
```

The coverage details now report:

```text
profiles; app=...; platform=...; country=...; concern=...
```

A zero Concern count indicates that the Concern field ID is incorrect or that the selected Zendesk tickets have no Concern value.

## Tests

```bash
npm run test:phase3-step4
npm run test:zendesk-integration
```

## Manual production sequence

1. Apply `supabase/migrations/20260701_phase3_step4b_concern_dimension.sql` in Supabase.
2. Add `ZENDESK_CONCERN_CUSTOM_FIELD_ID` to Cloudflare Pages production variables using the numeric ID of the Zendesk **Concerns** ticket field.
3. Remove the obsolete `ZENDESK_DRIVER_CUSTOM_FIELD_ID` and `ZENDESK_DRIVER_FIELD_ID` variables if either exists.
4. Redeploy the Cloudflare Pages project.
5. Call the protected backfill endpoint until `hasMore` is `false`.
6. Run the Step 4 verification SQL.
7. Confirm the coverage details show a non-zero `concern` count.
