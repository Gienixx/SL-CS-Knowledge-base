import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260812115418_agent_prepaid_balance_read.sql'

test('agent prepaid balance RPC is authenticated and identity scoped', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace function public\.workforce_list_my_prepaid_balances\(\)/)
  assert.match(migration, /v_employee_id uuid := public\.workforce_current_profile_id\(\)/)
  assert.match(migration, /prepaid\.employee_id = v_employee_id/)
  assert.match(migration, /prepaid\.remaining_minutes > 0/)
  assert.match(migration, /prepaid\.voided_at is null/)
  assert.doesNotMatch(migration, /p_employee_id|p_user_id|p_employee_user_id/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(
    migration,
    /revoke all on function public\.workforce_list_my_prepaid_balances\(\)[\s\S]*?from public, anon, authenticated/
  )
  assert.match(
    migration,
    /grant execute on function public\.workforce_list_my_prepaid_balances\(\)[\s\S]*?to authenticated, service_role/
  )
  assert.doesNotMatch(migration, /hourly_rate|gross_pay|net_pay|approval_reason|payroll_controls/i)
})

test('Attendance renders only outstanding prepaid balances in a compact read-only card', async () => {
  const [html, script, styles] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('styles/attendance.css')
  ])

  assert.match(html, /id="attendancePrepaidBalance"[^>]+hidden/)
  assert.match(html, /Prepaid Hours Balance/)
  assert.match(html, /id="attendancePrepaidBalanceBody"/)
  assert.match(script, /workforce_list_my_prepaid_balances/)
  assert.match(script, /prepaidBalances\.length/)
  assert.match(script, /Original:/)
  assert.match(script, /Fulfilled:/)
  assert.match(script, /Remaining:/)
  assert.match(script, /formatPrepaidTime\(balance\.prepaid_clock_in, balance\.timezone\)/)
  assert.match(script, /formatPrepaidTime\(balance\.prepaid_clock_out, balance\.timezone\)/)
  assert.match(styles, /\.attendance-prepaid-card/)
  assert.match(styles, /\.attendance-prepaid-balance-item/)
})

test('Attendance refreshes prepaid balances with normal attendance refreshes', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /async function loadPrepaidBalances\(\)/)
  assert.match(script, /loadToday\(\), loadHistory\(\), loadPrepaidBalances\(\)/)
})
