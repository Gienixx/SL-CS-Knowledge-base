import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const serverFiles = [
  'functions/_shared/google-calendar.js',
  'functions/google-calendar/connect.js',
  'functions/google-calendar/callback.js',
  'functions/google-calendar/status.js',
  'functions/google-calendar/events.js',
  'functions/google-calendar/disconnect.js'
]

test('Google Calendar migration creates server-only OAuth storage', async () => {
  const migration = await read(
    'supabase/migrations/2026071001_google_calendar_connections.sql'
  )

  assert.match(migration, /create table if not exists public\.google_calendar_connections/)
  assert.match(migration, /create table if not exists public\.google_calendar_oauth_states/)
  assert.match(migration, /encrypted_refresh_token text not null/)
  assert.match(migration, /alter table public\.google_calendar_connections enable row level security/)
  assert.match(migration, /alter table public\.google_calendar_oauth_states enable row level security/)
  assert.match(migration, /revoke all on public\.google_calendar_connections from anon, authenticated/)
  assert.match(migration, /revoke all on public\.google_calendar_oauth_states from anon, authenticated/)
})

test('Google Calendar server helper encrypts tokens and uses read-only scope', async () => {
  const helper = await read('functions/_shared/google-calendar.js')

  assert.match(helper, /https:\/\/www\.googleapis\.com\/auth\/calendar\.readonly/)
  assert.match(helper, /AES-GCM/)
  assert.match(helper, /crypto\.subtle\.encrypt/)
  assert.match(helper, /crypto\.subtle\.decrypt/)
  assert.match(helper, /crypto\.subtle\.digest\(\s*'SHA-256'/)
  assert.match(helper, /access_type', 'offline'/)
  assert.match(helper, /include_granted_scopes', 'true'/)
  assert.match(helper, /state', state/)
})

test('Google Calendar OAuth endpoints enforce authenticated initiation and single-use callback state', async () => {
  const connect = await read('functions/google-calendar/connect.js')
  const callback = await read('functions/google-calendar/callback.js')

  assert.match(connect, /requireAuthorizedUser\(context\)/)
  assert.match(connect, /google_calendar_oauth_states/)
  assert.match(connect, /10 \* 60 \* 1000/)
  assert.match(callback, /hashState\(state\)/)
  assert.match(callback, /used_at=is\.null/)
  assert.match(callback, /expires_at/)
  assert.match(callback, /exchangeGoogleAuthorizationCode/)
  assert.match(callback, /encryptSecret/)
  assert.match(callback, /resolution=merge-duplicates/)
})

test('Google Calendar callback always redirects to the root Home page', async () => {
  const helper = await read('functions/_shared/google-calendar.js')

  assert.match(helper, /return value === '\.\/home\.html' \|\| value === '\/home\.html'/)
  assert.match(helper, /\? '\/home\.html'/)
  assert.match(helper, /new URL\(safeReturnTo\(returnTo\), requestUrl\.origin\)/)
  assert.doesNotMatch(helper, /new URL\(safeReturnTo\(returnTo\), request\.url\)/)
})

test('Google Calendar events refresh server-side and expose only required event fields', async () => {
  const events = await read('functions/google-calendar/events.js')
  const sanitizeBlock = events.match(
    /function sanitizeEvent\(event\) \{[\s\S]*?\n\}/
  )?.[0] || ''

  assert.match(events, /requireAuthorizedUser\(context\)/)
  assert.match(events, /decryptSecret/)
  assert.match(events, /refreshGoogleAccessToken/)
  assert.match(events, /singleEvents', 'true'/)
  assert.match(events, /orderBy', 'startTime'/)
  assert.match(sanitizeBlock, /title:/)
  assert.match(sanitizeBlock, /start:/)
  assert.match(sanitizeBlock, /end:/)
  assert.match(sanitizeBlock, /location:/)
  assert.match(sanitizeBlock, /htmlLink:/)
  assert.doesNotMatch(sanitizeBlock, /attendees/)
  assert.doesNotMatch(sanitizeBlock, /description/)
  assert.doesNotMatch(sanitizeBlock, /conferenceData/)
})

test('Home exposes Google Calendar controls without browser secrets', async () => {
  const page = await read('home.html')
  const script = await read('scripts/home-google-calendar.js')

  assert.match(page, /id="googleCalendarConnectButton"/)
  assert.match(page, /id="googleCalendarDisconnectButton"/)
  assert.match(page, /id="googleCalendarStatus"/)
  assert.match(page, /home-google-calendar\.css\?v=1/)
  assert.match(page, /home-google-calendar\.js\?v=1/)
  assert.match(script, /\/google-calendar\/status/)
  assert.match(script, /\/google-calendar\/connect/)
  assert.match(script, /\/google-calendar\/events/)
  assert.match(script, /\/google-calendar\/disconnect/)
  assert.doesNotMatch(page, /GOOGLE_CLIENT_SECRET/)
  assert.doesNotMatch(script, /GOOGLE_CLIENT_SECRET/)
  assert.doesNotMatch(script, /GOOGLE_TOKEN_ENCRYPTION_KEY/)
})

test('Home overlays Google events and preserves workforce schedule priority', async () => {
  const script = await read('scripts/home-google-calendar.js')

  assert.match(script, /home-google-calendar-label/)
  assert.match(script, /has-google-calendar-event/)
  assert.match(script, /if \(!button\.classList\.contains\('has-work-schedule'\)\)/)
  assert.match(script, /UPCOMING_LIMIT - existingCards/)
  assert.match(script, /home-google-event-card/)
  assert.match(script, /Google Calendar:/)
})

test('Google Calendar verification and deployment documentation are present', async () => {
  const verification = await read(
    'supabase/verification/google_calendar_connections_check.sql'
  )
  const documentation = await read('docs/google-calendar-team-calendar.md')

  assert.match(verification, /Every blocker query in section 3 must return zero rows/)
  assert.match(verification, /authenticated_can_select_connections_should_be_false/)
  assert.match(verification, /encrypted_refresh_token not like 'v1\.%'/)
  assert.match(documentation, /GOOGLE_CLIENT_ID/)
  assert.match(documentation, /GOOGLE_CLIENT_SECRET/)
  assert.match(documentation, /GOOGLE_CALENDAR_REDIRECT_URI/)
  assert.match(documentation, /GOOGLE_TOKEN_ENCRYPTION_KEY/)
  assert.match(documentation, /Google events are not published to other employees/)
})

for (const file of [...serverFiles, 'scripts/home-google-calendar.js']) {
  test(`${file} has valid JavaScript syntax`, () => {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, result.stderr)
  })
}
