import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260812152037_gate_attendance_log_regular_minutes_on_approval.sql'

test('Attendance Log RPC is employee scoped and includes schedules plus actual ledger fulfillment', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create(?: or replace)? function public\.workforce_list_my_attendance_log\(\s*p_start_date date,\s*p_end_date date\s*\)/)
  assert.match(migration, /v_employee_id uuid := public\.workforce_current_profile_id\(\)/)
  assert.match(migration, /attendance_row\.user_id = v_employee_id/)
  assert.match(migration, /attendance_row\.review_status/)
  assert.match(migration, /review_status in \('approved', 'locked'\)/)
  assert.match(migration, /prepaid\.employee_id = v_employee_id/)
  assert.doesNotMatch(migration, /p_employee_id|p_user_id|p_employee_user_id/)
  assert.match(migration, /payroll_hour_allocations/)
  assert.match(migration, /allocation\.allocation_type = 'settlement'/)
  assert.match(migration, /else -allocation\.allocated_minutes/)
  assert.match(migration, /not exists \([\s\S]*?from public\.attendance/)
  assert.match(migration, /union all/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(migration, /prepaid\.remaining_minutes|prepaid\.settled_minutes/)
  assert.match(
    migration,
    /revoke all on function public\.workforce_list_my_attendance_log\(date, date\)[\s\S]*?from public, anon, authenticated/
  )
})

test('Attendance Log distinguishes scheduled prepaid, fulfilled prepaid, and regular minutes', async () => {
  const [html, script, styles] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('styles/attendance.css')
  ])

  assert.match(html, /<th>Billed Clock In<\/th>/)
  assert.match(html, /<th>Billed Clock Out<\/th>/)
   assert.match(html, /scripts\/attendance\.js\?v=29/)
  assert.match(html, /styles\/attendance-theme-fix\.css\?v=8/)
  assert.match(script, /workforce_list_my_attendance_log/)
  assert.match(script, /Prepaid scheduled/)
  assert.match(script, /Prepaid \$\{formatMinutes\(fulfilledMinutes\)\}/)
  assert.match(script, /Regular \$\{formatMinutes\(regularMinutes\)\}/)
  assert.match(script, /record\.is_prepaid_schedule/)
  assert.match(script, /record\.fulfilled_prepaid_minutes/)
  assert.match(script, /record\.regular_payable_minutes/)
  assert.match(script, /For review/)
  assert.match(script, /pendingApproval/)
  assert.match(styles, /\.attendance-prepaid-schedule-row/)
  assert.match(styles, /\.attendance-pay-type/)
})

test('Attendance Log badges use readable light-theme semantic tags without changing dark mode', async () => {
  const [script, lightStyles] = await Promise.all([
    read('scripts/attendance.js'),
    read('styles/attendance-theme-fix.css')
  ])

  assert.match(lightStyles, /html\[data-site-theme="light"\] \.attendance-history-card :is\([\s\S]*\.attendance-pay-type \.wf-badge[\s\S]*border-radius: 999px/)
  assert.match(lightStyles, /\.attendance-history-card :is\([\s\S]*\.wf-badge\.muted[\s\S]*color: var\(--site-heading\)[\s\S]*background: var\(--site-neutral-soft\)/)
  assert.match(lightStyles, /\.attendance-history-card :is\([\s\S]*\.wf-badge\.warning[\s\S]*background: var\(--site-amber-soft\)/)
  assert.match(lightStyles, /\.attendance-history-card \.attendance-adjustments \.wf-badge\.attendance-rdot[\s\S]*background: var\(--site-blue-soft\)/)
  assert.match(script, /if \(label === 'RDOT'\) item\.classList\.add\('attendance-rdot'\)/)
  assert.doesNotMatch(lightStyles, /html\[data-site-theme="dark"\] \.attendance-history-card/)
})

test('Attendance Log keeps the outstanding balance card separate', async () => {
  const [html, script, lightStyles] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('styles/attendance-theme-fix.css')
  ])

  assert.match(html, /id="attendancePrepaidBalance"[^>]+hidden/)
  assert.match(script, /workforce_list_my_prepaid_balances/)
  assert.match(script, /workforce_list_my_attendance_log/)
  assert.match(lightStyles, /html\[data-site-theme="light"\] \.attendance-prepaid-card/)
})
