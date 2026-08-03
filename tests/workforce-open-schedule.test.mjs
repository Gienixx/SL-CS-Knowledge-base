import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const [html, client, migration, attendanceMigration, theme] = await Promise.all([
  read('workforce.html'),
  read('scripts/workforce-schedules.js'),
  read('supabase/migrations/20260803090118_allow_open_schedules.sql'),
  read('supabase/migrations/20260803095337_allow_open_schedule_attendance.sql'),
  read('styles/site-theme.css')
])

test('create schedule offers an open schedule option', () => {
  assert.match(html, /id="scheduleIsOpen" type="checkbox"/)
  assert.match(html, /Open schedule \(no fixed clock-in or clock-out\)/)
  assert.match(client, /const openScheduleInput = document\.getElementById\('scheduleIsOpen'\)/)
})

test('schedule option cards remain readable in both site themes', () => {
  assert.match(html, /styles\/site-theme\.css\?v=5/)
  assert.match(theme, /html\[data-site-theme\] \.wf-check-card \{[\s\S]*color: var\(--site-text\);[\s\S]*background: var\(--site-surface-solid\);/)
  assert.match(theme, /\.wf-check-card:has\(input:checked\)/)
})

test('saved open schedule chips have readable themed text and backgrounds', () => {
  assert.match(theme, /html\[data-site-theme\] \.wf-schedule-chip\.open \{[\s\S]*background: color-mix\(in srgb, var\(--site-blue\) 10%, var\(--site-surface-solid\)\);/)
  assert.match(theme, /\.wf-schedule-chip\.open \.wf-chip-main \{[\s\S]*color: var\(--site-blue\);/)
  assert.match(theme, /\.wf-schedule-chip\.open \.wf-chip-main small \{[\s\S]*color: var\(--site-muted\);[\s\S]*opacity: 1;/)
})

test('open schedule disables and clears fixed time settings', () => {
  assert.match(client, /const hasNoFixedTimes = isRestDay \|\| isOpenSchedule/)
  assert.match(client, /start\.disabled = hasNoFixedTimes/)
  assert.match(client, /end\.disabled = hasNoFixedTimes/)
  assert.match(client, /if \(hasNoFixedTimes\) \{[\s\S]*start\.value = ''[\s\S]*end\.value = ''/)
  assert.match(client, /openScheduleInput\.addEventListener\('change'/)
})

test('open schedule is exclusive with rest day and holiday', () => {
  assert.match(client, /if \(selectedInput === openScheduleInput\) \{[\s\S]*restDayInput\.checked = false[\s\S]*holidayInput\.checked = false/)
  assert.match(client, /else \{[\s\S]*openScheduleInput\.checked = false/)
})

test('open schedules save without shift times and remain clearly labeled', () => {
  assert.match(client, /workforce_admin_save_open_schedule/)
  assert.match(client, /if \(!schedule\.shift_start && !schedule\.shift_end\) return 'Open schedule'/)
  assert.match(client, /isOpenSchedule \? 'open' : 'shift'/)
})

test('database permits only non-holiday open schedule placeholders', () => {
  assert.match(migration, /not is_holiday[\s\S]*shift_start is null[\s\S]*shift_end is null/)
  assert.match(migration, /create or replace function public\.workforce_admin_save_open_schedule/)
  assert.match(migration, /not public\.workforce_can_manage_user\(p_user_id, 'manage_schedules'\)/)
  assert.match(migration, /null, null, v_timezone, v_status, false, false, null/)
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/)
  assert.match(migration, /grant execute[\s\S]*to authenticated/)
})

test('attendance can be recorded against an open schedule without fixed-time calculations', () => {
  assert.match(attendanceMigration, /create or replace function public\.workforce_recalculate_attendance\(/)
  assert.doesNotMatch(attendanceMigration, /Normal attendance requires a complete scheduled shift/)
  assert.match(attendanceMigration, /workforce_calculate_attendance\([\s\S]*v_schedule\.shift_start[\s\S]*v_schedule\.shift_end/)
  assert.match(attendanceMigration, /'open_schedule_attendance_enabled'/)
})
