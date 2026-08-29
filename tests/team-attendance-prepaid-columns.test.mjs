import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260728073925_add_prepaid_columns_to_team_attendance.sql'
const shiftAliasFixMigrationPath = 'supabase/migrations/20260827105406_fix_team_attendance_prepaid_shift_alias.sql'

test('Team Attendance exposes every calculated prepaid reconciliation column', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')

  for (const heading of [
    'Prepaid login',
    'Prepaid logout',
    'Prepaid time',
    'Actual eligible',
    'Applied to prepaid',
    'Remaining prepaid',
    'Prepaid status'
  ]) {
    assert.match(page, new RegExp(`>${heading}<`))
  }

  assert.match(script, /supabase\.rpc\('workforce_list_team_attendance_prepaid'/)
  assert.match(script, /prepaidByAttendance\.get\(row\.attendance_id\)/)

  for (const field of [
    'prepaid_clock_in',
    'prepaid_clock_out',
    'prepaid_minutes',
    'actual_eligible_minutes',
    'applied_prepaid_minutes',
    'remaining_prepaid_minutes',
    'prepaid_status'
  ]) {
    assert.match(script, new RegExp(`\\b${field}\\b`))
  }
})

test('prepaid attendance values stay non-monetary and permission scoped', async () => {
  const migration = await read(migrationPath)
  const verification = await read('supabase/verification/team_attendance_prepaid_columns_check.sql')

  assert.match(migration, /create or replace function public\.workforce_list_team_attendance_prepaid\(/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(migration, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(migration, /workforce_can_manage_user\([\s\S]*?'view_team_attendance'/)
  assert.match(
    migration,
    /revoke all on function public\.workforce_list_team_attendance_prepaid\(date, date\)[\s\S]*?from public, anon, authenticated/
  )
  assert.match(
    migration,
    /grant execute on function public\.workforce_list_team_attendance_prepaid\(date, date\)[\s\S]*?to authenticated, service_role/
  )
  assert.doesNotMatch(migration, /\b(agent_rates|hourly_rate|daily_rate|monthly_rate|gross_pay|net_pay)\b/)
  assert.match(verification, /Every blocker query must return zero rows/)
  assert.match(verification, /team_attendance_prepaid_columns_ready/)
})

test('eligible and applied minutes follow the prepaid reconciliation rules', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /attendance_row\.regular_minutes/)
  assert.match(migration, /attendance_row\.pre_shift_overtime_minutes/)
  assert.match(migration, /attendance_row\.post_shift_overtime_minutes/)
  assert.match(migration, /schedule\.is_rest_day/)
  assert.match(migration, /schedule\.is_holiday/)
  assert.match(migration, /attendance_row\.rest_day_overtime_minutes/)
  assert.match(migration, /attendance_row\.holiday_overtime_minutes/)
  assert.match(migration, /allocation\.allocation_type = 'settlement'/)
  assert.match(migration, /else -allocation\.allocated_minutes/)
  assert.match(migration, /source_prepaid\.remaining_minutes/)
  assert.match(migration, /source_prepaid\.status/)
})

test('admin prepaid Team Attendance keeps effective shift values addressable by the lateral source', async () => {
  const migration = await read(shiftAliasFixMigrationPath)

  assert.match(migration, /workforce_list_team_attendance_prepaid\(date,date\)/)
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_shift_start, snapshot\.shift_start\) as shift_start/
  )
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_shift_end, snapshot\.shift_end\) as shift_end/
  )
  assert.match(migration, /source_prepaid\.shift_start/)
  assert.match(migration, /source_prepaid\.shift_end/)
  assert.doesNotMatch(migration, /alter table public\.payroll_prepaid_hours[\s\S]*add column[^;]*shift_start/)
})
