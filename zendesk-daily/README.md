# Zendesk Daily Performance (separate pipeline)

This package is independent of the existing Google Sheets Analytics sync. It adds a separate Cloudflare Worker, Cloudflare D1 database, API, and dashboard. It does not call any Attendance, Payroll, scheduling, or existing sync routes. The Worker has no write scopes and uses its OAuth refresh-token flow; the standalone parity validator also accepts a standard Zendesk API token for read-only checks.

## Architecture

- **Schedule:** Cloudflare Worker Cron `0 22 * * *` UTC, which is 6:00 AM Asia/Manila. It targets the previous Manila calendar day. Intended cutoff, actual start/end, status, and maximum ticket update watermark are logged.
- **Collector:** Zendesk Incremental Ticket Export (cursor), per-ticket Ticket Metrics, per-ticket Ticket Audits, `users/show_many` (only to classify comment authors as agents), and Satisfaction Ratings. The incremental export is paced to at most one request every 6.1 seconds (Zendesk documents a 10 requests/minute limit); other 429/5xx responses retry. It stores no subjects, descriptions, requester IDs, names, email addresses, comments, attachments, or raw API responses.
- **Persistence:** isolated D1 database (`sl-cs-zendesk-daily`). The proposed schema is in `worker/migrations/0001_init.sql`; it is a D1 migration and must be applied only to a newly created, dedicated database after release review. Cursor and minimal per-ticket metric staging support resume; staging is deleted after finalization. Final daily agent rows are immutable. Corrections append a separate audit record and become effective through a view.
- **Dashboard:** Cloudflare Worker static asset at `/`, protected data APIs, date and agent filters, seven metrics, trend chart, and run health. Put this Worker hostname behind Cloudflare Access. The Worker independently validates the Access JWT. Correction writes additionally require an allowlisted email.
- **Security boundary:** OAuth refresh and client secrets, encryption key, and initial refresh token are Worker secrets. The OAuth refresh token is encrypted before it is persisted in D1; access tokens are held in memory only. Dashboard source contains no secrets.

## Zendesk API endpoints

All Support endpoints use `https://{subdomain}.zendesk.com/api/v2` and Bearer OAuth authentication.

1. `GET /incremental/tickets/cursor?start_time={epoch}` — tickets updated from the inclusive start watermark; follow each returned `next_page` cursor.
2. `GET /tickets/{ticket_id}/metrics` — solved time, first reply, requester wait, full resolution, replies, and reopen count.
3. `GET /tickets/{ticket_id}/audits?page[size]=100` — assignment/status events and public comments. Keep only timestamps, actor/assignee IDs, status transitions, and a boolean reply count in memory; discard comment bodies.
4. `GET /users/show_many?ids={comma-separated-ids}` — role only for audit comment authors; names/emails are discarded.
5. `GET /satisfaction_ratings?start_time={epoch}&end_time={epoch}&page[size]=100` — score and timestamp only; discard rating comments.
6. **Separate mapping verification only:** `GET /users/search?query={username}&per_page=100`. Review candidates manually and set immutable user IDs only after identity is confirmed. The Worker does not infer IDs from display names or handles.
7. `POST https://{subdomain}.zendesk.com/oauth/tokens` with `grant_type=refresh_token`, `refresh_token`, `client_id`, and `client_secret`. Zendesk returns replacement access and refresh tokens; persist the new refresh token before continuing.

The incremental ticket export and satisfaction-rating list are documented as Admin-only endpoints. Use a Zendesk administrator account authorized for this reporting integration, but issue a confidential OAuth token with only the global `read` scope. The audit endpoint also requires global `read`; `tickets:read` alone does not satisfy it. The user search endpoint can match arbitrary user properties, so verification output is deliberately limited to candidate ID, name, role, and active status and must not be used to guess ambiguous IDs.

## Metric contract currently encoded

- **Solved tickets:** distinct tickets whose final `solved_at` is in the Manila reporting day, attributed to the assignee at the final solve event, falling back to the solve actor only when no assignee can be determined.
- **First reply, requester wait, full resolution:** Zendesk ticket metric `calendar` values; daily display uses the median of ticket values. A missing metric remains `null` and is excluded from its median.
- **Last assignment to resolution:** elapsed calendar minutes from the latest non-null `assignee_id` assignment event before the final solve audit to `solved_at`; clearing an assignment does not replace the last assigned timestamp. If the assignment event is absent, store `null`. Zendesk documents this metric as solved timestamp minus last assigned timestamp.
- **CSAT:** favorable ratings divided by received good/bad ratings whose `created_at` is in the day. No responses means `null`. The final date attribute and Explore denominator must be checked against the benchmark export.
- **One touch:** percentage of solved tickets with at most one public agent comment and no reopen. Tickets created through the API are excluded as unavailable because Zendesk documents a special proactive-ticket rule that cannot be identified reliably from this minimized API projection. No denominator means `null`.
- **Time basis and filters:** midnight-to-midnight Asia/Manila bounds for solved tickets. Calendar metrics, not business-hour metrics. For CSAT, the rating date is used. Explore commonly uses metric-specific date attributes and may configure median versus average; exact report parity is pending benchmark CSVs and the source Explore report definitions.

This is an explicit initial calculation contract, not a claim of verified parity. October 21 and 22 benchmark CSVs are available and recorded in the release review. API parity remains unassessed because no live API collection was run. Explore filter/aggregation definitions are still pending.

## OAuth and deployment setup (release-gated)

1. In Zendesk Admin Center, register a dedicated OAuth client for the reporting integration, with only `read` scope. Complete the authorization grant and keep the initial refresh token private. Do not create/use an API token.
2. After mapping verification, set `ZENDESK_AGENT_IDS_JSON` with exactly the five keys `amora`, `gen`, `arby`, `ford`, `tommy`. The current mapping deliberately contains no IDs. For Tommy Fang, verify the `automated` user candidate with an account administrator; never infer his immutable ID.
3. Create a **new, dedicated** D1 database; set its ID in the package-local `wrangler.toml`; configure the hostname behind Cloudflare Access; create a policy for dashboard readers and a narrower correction admin allowlist.
4. Set Worker secrets with `wrangler secret put ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET`, `ZENDESK_REFRESH_TOKEN`, `OAUTH_ENCRYPTION_KEY`, and `CORRECTION_ADMIN_EMAILS`. The encryption key is base64 for 32 random bytes. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are non-secret Worker variables; the agent ID map is a non-secret account identifier map. Keep the correction email allowlist in a secret.
5. Apply `wrangler d1 migrations apply sl-cs-zendesk-daily --local` and run offline tests first. Production D1 creation, migration application, OAuth connection, live collection, Access routing, and Worker deployment each require their own release review. Never apply this migration to the existing application/Supabase database.

### Rotation and expiry

Zendesk refresh tokens rotate on each refresh. The replacement is encrypted and persisted before API calls. Access tokens are not persisted. If a refresh fails or the refresh token expires, the Worker marks the run failed and retains a reason/status without logging token values. Reauthorize in Zendesk and set a new `ZENDESK_REFRESH_TOKEN` secret; the next successful refresh replaces the encrypted D1 copy. Keep `OAUTH_ENCRYPTION_KEY` stable; rotating it requires a separately reviewed decrypt/re-encrypt procedure for the D1 refresh-token row before changing the Worker secret.

## Operations and limitations

- An invocation processes up to 12 incremental ticket pages, saving `next_page_url` after each completed page. If more pages remain, run status is `incomplete`; an authorized administrator can resume that date with `POST /api/run?day=YYYY-MM-DD` while Access is active. Replayed pages upsert staging rows by ticket ID.
- A run is flagged `late` when finalization is more than ten minutes after its intended cutoff. This is not a historical as-of reconstruction. Incremental exports deliberately omit the most recent minute to prevent race conditions; ticket metric endpoints expose current aggregate values; Zendesk does not provide a general point-in-time snapshot API for the requested 6:00 AM state. Any later run can therefore reflect a reopen, rating, or update after cutoff. The dashboard shows actual timestamps and the highest observed generated timestamp (falling back to `updated_at`); do not call the data exact as-of.
- The API audit needs a bounded event history per solved ticket and the calculation performs multiple API reads. Rate limit `429` and transient `5xx` responses retry with `Retry-After`/Zendesk reset headers and capped exponential backoff.
- `/api/daily` and `/api/runs` require a valid Cloudflare Access JWT. `/api/run` and `/api/corrections` also require an allowlisted administrator email. Correction values are append-only; base snapshots never update or delete.

## Offline verification

Run `npm run test:zendesk-daily`. It uses synthetic ticket, metric, audit, and rating fixtures, plus mocked cursor and rate-limit responses. It never contacts Zendesk, Supabase, D1 production, or Cloudflare. The benchmark CSVs are external to the repository at `G:\downloads\1021` and `G:\downloads\1022`.

### Read-only parity validator

`node zendesk-daily/scripts/validate-readonly.mjs` performs a bounded validation for October 21–22, 2026. Configure `ZENDESK_SUBDOMAIN` and either a pre-issued OAuth access token in `ZENDESK_ACCESS_TOKEN`, or both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN`. OAuth uses `Authorization: Bearer`; standard API-token authentication uses HTTP Basic with `email/token:api_token`. OAuth takes precedence when both are configured. The validator only sends GET requests; it does not refresh credentials, write to a database, or store the credentials. It verifies the six supplied candidate IDs with `GET /users/show_many`, then paginates Search Export results, reads ticket metrics and audits, filters solved timestamps to Asia/Manila day bounds, attributes tickets to the assignee at solve time, and reports counts and one-touch numerators by numeric assignee ID. Arez is verified as an identity candidate but excluded from all five-agent reporting totals. No identity mapping is finalized from candidate names.

Search date filters use Zendesk account-local dates and may miss tickets whose current status changed after the benchmark date. Metric and audit endpoints expose current ticket state/history, not a general as-of snapshot. Results from this script must therefore be reconciled against verified IDs and Explore definitions before any parity claim.
