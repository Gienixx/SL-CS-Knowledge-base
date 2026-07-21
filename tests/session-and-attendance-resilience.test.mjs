import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('browser modules reuse one Supabase auth client', async () => {
  const [client, home, userName, calendar, workforceCalendar, workforceNav] = await Promise.all([
    read('scripts/supabaseClient.js'),
    read('scripts/home.js'),
    read('scripts/home-user-name.js'),
    read('scripts/home-google-calendar.js'),
    read('scripts/home-workforce-calendar.js'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(client, /window\.__slSupabase \|\| createClient/)
  for (const source of [home, userName, calendar, workforceCalendar, workforceNav]) {
    assert.match(source, /supabaseClient\.js\?v=10/)
  }
  assert.match(home, /signOut\(\{ scope: 'local' \}\)/)
  assert.match(home, /finally[\s\S]*window\.location\.replace\('\.\/login\.html'\)/)
})

test('attendance requests time out and always release the busy state', async () => {
  const attendance = await read('scripts/attendance.js')

  assert.match(attendance, /const REQUEST_TIMEOUT_MS = 15000/)
  assert.ok((attendance.match(/\.abortSignal\(requestSignal\(\)\)/g) || []).length >= 5)
  assert.match(attendance, /async function clockOut\(\)[\s\S]*finally \{\s*setBusy\(false\)/)
  assert.match(attendance, /async function refreshAll[\s\S]*finally \{\s*setBusy\(false\)/)
})
