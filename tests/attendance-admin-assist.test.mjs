import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Attendance exposes local-only Admin Assist navigation and cache-busted assets', async () => {
  const [html, styles, lightStyles] = await Promise.all([
    read('attendance.html'),
    read('styles/attendance.css'),
    read('styles/attendance-theme-fix.css')
  ])

  for (const id of [
    'attendanceAdminAssist',
    'attendanceAdminAssistTitle',
    'attendanceAdminAssistTeam',
    'attendanceAdminAssistEnter',
    'attendanceAdminAssistExit',
    'attendanceAdminAssistPrevious',
    'attendanceAdminAssistNext'
  ]) assert.match(html, new RegExp(`id="${id}"`))

  assert.match(html, /attendance\.css\?v=9/)
  assert.match(html, /attendance-theme-fix\.css\?v=6/)
  assert.match(html, /scripts\/attendance\.js\?v=18/)
  assert.match(styles, /attendance-admin-assist-arrow-previous/)
  assert.match(styles, /attendance-admin-assist-arrow-next/)
  assert.match(lightStyles, /attendance-admin-assist/)
})

test('Admin Assist is permission-gated and uses employee-scoped snapshot/action RPCs', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /access\?\.is_admin === true &&[\s\S]*view_team_attendance[\s\S]*correct_attendance/)
  assert.match(script, /workforce_admin_assist_list_employees/)
  assert.match(script, /supabase\.rpc\('workforce_admin_assist_list_employees'\)/)
  assert.match(script, /workforce_admin_assist_snapshot/)
  assert.match(script, /p_target_user_id: adminAssistTarget\.user_id/)
  assert.match(script, /workforce_admin_assist_clock_in/)
  assert.match(script, /workforce_admin_assist_clock_out/)
  assert.match(script, /window\.prompt\(`Reason for Admin Assist/)
  assert.match(script, /adminAssistOriginalAccess/)
  assert.match(script, /profileIds = \[adminAssistTarget\.user_id\]/)
  assert.match(script, /if \(adminAssistMode\)/)
  assert.match(script, /if \(!adminAssistAllowed\) return/)
  assert.match(script, /workforce_clock_in/)
  assert.match(script, /workforce_clock_out/)
})

test('Admin Assist migration protects target reads/actions and writes explicit actor audit events', async () => {
  const migration = await read('supabase/migrations/20260812154336_admin_attendance_assist_local_prototype.sql')

  assert.match(migration, /security definer/i)
  assert.match(migration, /workforce_is_authorized_attendance_admin\('correct_attendance'\)/g)
  assert.match(migration, /p_target_user_id uuid/)
  assert.match(migration, /workforce_admin_assist_clock_in/)
  assert.match(migration, /workforce_admin_assist_clock_out/)
  assert.match(migration, /create or replace function public\.workforce_admin_assist_list_employees\(\)/)
  assert.match(migration, /raise exception 'Admin attendance permission is required\.'/)
  assert.match(migration, /admin_assisted_clock_in/)
  assert.match(migration, /admin_assisted_clock_out/)
  assert.match(migration, /actor_user_id/)
  assert.match(migration, /required|reason/i)
  assert.match(migration, /revoke all on function public\.workforce_admin_assist_snapshot/)
  assert.doesNotMatch(migration, /workforce_clock_in\(/)
  assert.doesNotMatch(migration, /workforce_clock_out\(/)
})

test('Admin Assist leaves the existing correction workflow untouched', async () => {
  const [script, migration] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260812154336_admin_attendance_assist_local_prototype.sql')
  ])

  assert.doesNotMatch(script, /workforce_correct_attendance/)
  assert.doesNotMatch(migration, /workforce_correct_attendance\(/)
  assert.match(migration, /does not change correction behavior/i)
})

test('Attendance client remains bound to the live Supabase project for the local frontend', async () => {
  const client = await read('scripts/supabaseClient.js')
  assert.match(client, /https:\/\/kfhyckyrgplkqhsbuwnx\.supabase\.co/)
  assert.doesNotMatch(client, /127\.0\.0\.1:54321|__slLocalSupabaseConfig/)
})

test('Admin Assist arrows keep a stationary, non-glowing hover and active state', async () => {
  const [styles, lightStyles] = await Promise.all([
    read('styles/attendance.css'),
    read('styles/attendance-theme-fix.css')
  ])

  assert.match(styles, /\.attendance-admin-assist-arrow \{[\s\S]*top: calc\(50% - 24px\)[\s\S]*transform: none !important[\s\S]*box-shadow: none !important/)
  assert.match(styles, /\.attendance-admin-assist-arrow:hover:not\(:disabled\) \{[\s\S]*transform: none !important[\s\S]*box-shadow: none !important/)
  assert.match(styles, /\.attendance-admin-assist-arrow:active \{[\s\S]*transform: none !important[\s\S]*box-shadow: none !important/)
  const arrowHover = styles.match(/\.attendance-admin-assist-arrow:hover:not\(:disabled\)\s*\{([\s\S]*?)\}/)?.[1] || ''
  const arrowActive = styles.match(/\.attendance-admin-assist-arrow:active\s*\{([\s\S]*?)\}/)?.[1] || ''
  const lightArrowHover = lightStyles.match(/\.attendance-admin-assist-arrow:hover:not\(:disabled\)\s*\{([\s\S]*?)\}/)?.[1] || ''

  assert.doesNotMatch(arrowHover, /translateY|translateX|scale\(/)
  assert.doesNotMatch(arrowActive, /translateY|translateX|scale\(/)
  assert.doesNotMatch(lightArrowHover, /translateY|translateX|scale\(|box-shadow:\s*(?!none)/)
})

test('Admin Assist entry control has no inherited green glow', async () => {
  const styles = await read('styles/attendance.css')
  const enter = styles.match(/\.attendance-admin-assist-enter\s*\{([\s\S]*?)\}/)?.[1] || ''
  const enterHover = styles.match(/\.attendance-admin-assist-enter:hover:not\(:disabled\)[\s\S]*?\{([\s\S]*?)\}/)?.[1] || ''
  const enterActive = styles.match(/\.attendance-admin-assist-enter:active:not\(:disabled\)[\s\S]*?\{([\s\S]*?)\}/)?.[1] || ''

  assert.match(enter, /box-shadow:\s*none\s*!important/)
  assert.match(enterHover, /box-shadow:\s*none\s*!important/)
  assert.match(enterActive, /box-shadow:\s*none\s*!important/)
})

test('Admin Assist banner uses compact Attendance spacing and controls', async () => {
  const styles = await read('styles/attendance.css')
  const banner = styles.match(/\.attendance-admin-assist\s*\{([\s\S]*?)\}/)?.[1] || ''
  const control = styles.match(/\.attendance-admin-assist \.wf-row-btn\s*\{([\s\S]*?)\}/)?.[1] || ''

  assert.match(banner, /gap:\s*10px/)
  assert.match(banner, /padding:\s*7px 10px/)
  assert.match(control, /min-height:\s*28px/)
  assert.match(control, /font-size:\s*\.68rem/)
})

test('Attendance controls have no decorative green glow or hover movement', async () => {
  const [styles, lightStyles] = await Promise.all([
    read('styles/attendance.css'),
    read('styles/attendance-theme-fix.css')
  ])

  assert.match(styles, /Attendance controls stay stationary and use borders\/tints instead of glow/)
  assert.match(styles, /\.attendance-app :is\([\s\S]*?\):hover:not\(:disabled\)[\s\S]*?transform: none !important;[\s\S]*?box-shadow: none !important;/)
  assert.match(styles, /\.attendance-app :is\([\s\S]*?\):focus-visible[\s\S]*?box-shadow: none !important;/)
  assert.match(styles, /\.attendance-live-dot,[\s\S]*?\.attendance-status-light[\s\S]*?box-shadow: none;/)
  assert.match(lightStyles, /attendance-actions :is\([\s\S]*?box-shadow: none !important;/)
})

test('Admin Assist entry and exit controls match arrow hover and active states', async () => {
  const styles = await read('styles/attendance.css')

  assert.match(styles, /\.attendance-admin-assist-enter:hover:not\(:disabled\),\s*\.attendance-admin-assist \.wf-row-btn:hover:not\(:disabled\)\s*\{[\s\S]*?border-color: color-mix\(in srgb, var\(--site-blue\) 72%, var\(--site-border\)\)[\s\S]*?background: color-mix\(in srgb, var\(--site-blue\) 10%, var\(--site-surface-solid\)\)[\s\S]*?transform: none !important;/)
  assert.match(styles, /\.attendance-admin-assist-enter:active:not\(:disabled\),\s*\.attendance-admin-assist \.wf-row-btn:active:not\(:disabled\)\s*\{[\s\S]*?background: color-mix\(in srgb, var\(--site-blue\) 16%, var\(--site-surface-solid\)\)[\s\S]*?transform: none !important;/)
})
