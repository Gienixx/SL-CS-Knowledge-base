# Google Calendar Integration for the Home Team Calendar

## Scope

The first integration release is read-only and private per user.

Each signed-in user can connect a Google account from Home. Google events from that account are then overlaid on that user's Home calendar and added to available slots in Upcoming Events.

Google events are not published to other employees and are not written into workforce schedules.

## Security model

- The browser never receives the Google client secret or refresh token.
- OAuth authorization begins through an authenticated Cloudflare Pages Function.
- OAuth state values are random, stored only as SHA-256 hashes, expire after 10 minutes, and are single-use.
- Refresh tokens are encrypted with AES-256-GCM before storage.
- The encryption key is stored only as a Cloudflare secret.
- Google access uses the read-only Calendar scope.
- Supabase browser roles have no direct access to either Google Calendar table.
- Disconnect attempts token revocation and removes local connection data.

## Database deployment

Apply:

```text
supabase/migrations/2026071001_google_calendar_connections.sql
```

Then run:

```text
supabase/verification/google_calendar_connections_check.sql
```

Every blocker query in verification section 3 must return zero rows.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable the Google Calendar API.
3. Configure the OAuth consent screen.
4. Create an OAuth client with application type **Web application**.
5. Add the exact production callback URL as an authorized redirect URI:

```text
https://YOUR-PAGES-DOMAIN/google-calendar/callback
```

The scheme, hostname, path, and trailing-slash behavior must match exactly.

For a custom production domain, use that custom domain in the redirect URI rather than the temporary Pages preview domain.

## Cloudflare Pages variables and secrets

Configure these bindings for the production environment:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALENDAR_REDIRECT_URI
GOOGLE_TOKEN_ENCRYPTION_KEY
```

Recommended classification:

- `GOOGLE_CLIENT_ID`: environment variable or secret
- `GOOGLE_CLIENT_SECRET`: secret
- `GOOGLE_CALENDAR_REDIRECT_URI`: environment variable
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: secret

`GOOGLE_CALENDAR_REDIRECT_URI` must exactly match the authorized redirect URI configured in Google Cloud.

Generate a 32-byte encryption key and store the Base64 or Base64URL result as `GOOGLE_TOKEN_ENCRYPTION_KEY`. Example:

```bash
openssl rand -base64 32
```

Do not commit any of these values to GitHub.

The existing Supabase bindings must also remain available to Pages Functions:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

## Cloudflare endpoints

```text
POST /google-calendar/connect
GET  /google-calendar/callback
GET  /google-calendar/status
GET  /google-calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD
POST /google-calendar/disconnect
```

Authenticated endpoints require the active Supabase access token in the `Authorization` header.

The callback is public because Google redirects the browser to it, but it accepts only an unexpired, unused, server-stored OAuth state value.

## Home behavior

When disconnected:

- Home shows **Connect Google Calendar**.
- No Google event data is requested.

When connected:

- Home shows the connected calendar name.
- Google events appear as blue labels in the calendar grid.
- Google events fill unused slots in Upcoming Events after workforce schedule entries.
- Clicking a Google-only calendar date opens the first Google event in a new tab.
- Dates that also contain workforce schedules retain the My Schedule click action.

## Event privacy

The event endpoint returns only the fields needed by Home:

```text
id
title
start
end
allDay
location
htmlLink
status
transparency
recurringEventId
```

Descriptions, attendees, conference data, attachments, and organizer details are not returned to the browser.

## Manual test checklist

1. Apply the migration and verification.
2. Configure all four Google bindings in Cloudflare Pages.
3. Add the exact callback URI in Google Cloud.
4. Deploy the integration branch to a test environment.
5. Sign in as a regular agent.
6. Select **Connect Google Calendar**.
7. Confirm the Google account chooser appears.
8. Approve read-only Calendar access.
9. Confirm the browser returns to Home.
10. Confirm the connected calendar name appears.
11. Confirm timed and all-day Google events appear on the correct dates.
12. Confirm workforce schedules remain visible.
13. Confirm Google events appear only for the connected user.
14. Confirm Upcoming Events prioritizes workforce entries and uses remaining slots for Google events.
15. Navigate to another month and confirm Google events refresh.
16. Disconnect and confirm Google labels and cards disappear.
17. Confirm the connection and OAuth-state tables are inaccessible through the browser Supabase key.
18. Revoke Google access externally and confirm Home requests reconnection instead of exposing an error trace.

## Later expansion

A later phase can add an administrator-selected shared Google calendar. That should be implemented as a separate team-level connection with explicit visibility controls rather than exposing one employee's personal calendar to the entire team.
