import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { effectiveAttendanceClocks, formatAttendanceTimestamp } from '../shared/attendance-billed-timestamps.js'

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
  assert.match(html, /attendance-theme-fix\.css\?v=8/)
   assert.match(html, /scripts\/attendance\.js\?v=29/)
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

test('Admin Assist history exposes the shared original and billed timestamp contract', async () => {
  const [migration, script] = await Promise.all([
    read('supabase/migrations/20260821130000_expose_billed_timestamps_in_admin_assist_history.sql'),
    read('scripts/attendance.js')
  ])

  assert.match(migration, /pg_get_functiondef\('public\.workforce_admin_assist_snapshot\(uuid,date,date\)'::regprocedure\)/)
  for (const field of [
    'attendance_row.original_clock_in',
    'attendance_row.original_clock_out',
    'attendance_row.billed_clock_in',
    'attendance_row.billed_clock_out'
  ]) assert.match(migration, new RegExp(field.replaceAll('.', '\\.'), 'g'))
  assert.match(script, /adminAssistSnapshot\.history \|\| \[\]\)\.map\(record => \(\{[\s\S]*\.\.\.record/)
  assert.match(script, /effectiveAttendanceClocks/)
  assert.doesNotMatch(migration, /\b(insert|update|delete)\b/i)
})

test('Admin Assist billed history preserves originals and uses shared fallback/formatting', () => {
  const record = {
    clock_in: '2026-08-20T01:00:00.000Z',
    clock_out: '2026-08-20T09:00:00.000Z',
    original_clock_in: '2026-08-20T01:00:00.000Z',
    original_clock_out: '2026-08-20T09:00:00.000Z',
    billed_clock_in: '2026-08-20T01:15:00.000Z',
    billed_clock_out: '2026-08-20T08:45:00.000Z',
    is_corrected: true
  }
  const clocks = effectiveAttendanceClocks(record)

  assert.equal(clocks.renderedClockIn, record.original_clock_in)
  assert.equal(clocks.renderedClockOut, record.original_clock_out)
  assert.equal(clocks.billedClockIn, record.billed_clock_in)
  assert.equal(clocks.billedClockOut, record.billed_clock_out)
  assert.equal(
    formatAttendanceTimestamp(record.billed_clock_in),
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(record.billed_clock_in))
  )

  const unchanged = effectiveAttendanceClocks({
    clock_in: record.clock_in,
    clock_out: record.clock_out,
    original_clock_in: record.original_clock_in,
    original_clock_out: record.original_clock_out,
    billed_clock_in: record.original_clock_in,
    billed_clock_out: record.original_clock_out
  })
  assert.equal(unchanged.billedClockIn, record.original_clock_in)
  assert.equal(unchanged.billedClockOut, record.original_clock_out)
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

test('historical Admin Assist clock-in preserves the RPC contract and server-side safeguards', async () => {
  const [script, live] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/reconciliation-archive/pre-canonical-migrations-20260819/live-production-definitions-20260819.sql')
  ])
  const timestampMigration = live.match(/-- signature: workforce_admin_assist_clock_in\(uuid,uuid,date,text,timestamp with time zone\)[\s\S]*?(?=-- LIVE PRODUCTION SNAPSHOT|$)/)?.[0] || ''
  const legacyMigration = live.match(/-- signature: workforce_admin_assist_clock_in\(uuid,uuid,date,text\)[\s\S]*?(?=-- LIVE PRODUCTION SNAPSHOT|$)/)?.[0] || ''

  assert.match(script, /p_schedule_id: scheduleId/)
  assert.match(script, /p_work_date: schedule\?\.shift_date \|\| localDateKey\(\)/)
  assert.match(script, /p_clock_in:|payload\.p_clock_in/)
  assert.match(script, /adminAssistMode\s*\?[\s\S]*!hasAttendanceForSchedule\(schedule\)/)
  assert.match(script, /actual historical Clock In date and time/)
  assert.match(script, /renderAdminAssistHistoricalClockIn/)
  assert.match(timestampMigration, /workforce_is_authorized_attendance_admin\('correct_attendance'\)/)
  assert.match(legacyMigration, /workforce_admin_assist_clock_in/)
  assert.match(timestampMigration, /p_clock_in (timestamp with time zone|timestamptz)/)
  assert.match(timestampMigration, /v_clock_in timestamptz := coalesce\(p_clock_in, now\(\)/)
  assert.match(timestampMigration, /v_clock_in at time zone v_timezone/)
  assert.match(timestampMigration, /v_is_historical and p_clock_in is null/)
  assert.match(timestampMigration, /v_allowed_overnight_date/)
  assert.match(timestampMigration, /timestamp_source.*manager_supplied_historical/)
  assert.match(timestampMigration, /v_schedule\.shift_date <> p_work_date/)
  assert.match(timestampMigration, /v_schedule\.is_leave or v_schedule\.is_absent/)
  assert.match(timestampMigration, /schedule_id = p_schedule_id[\s\S]*Attendance already exists for the selected schedule\./)
  assert.match(timestampMigration, /period\.status = 'finalized'/)
  assert.match(timestampMigration, /record\.status = 'finalized'/)
  assert.match(timestampMigration, /review_status,[\s\S]*'pending'/)
  assert.match(timestampMigration, /audit_source', 'admin_assisted_clock_in'/)
  assert.match(timestampMigration, /metadata/)
  assert.match(timestampMigration, /set search_path (TO|=) ['"]?public['"]?,? ['"]?pg_temp['"]?/i)
  assert.doesNotMatch(timestampMigration, /workforce_clock_in\(/)
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
