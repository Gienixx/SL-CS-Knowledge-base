import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260801055751_agent_live_team_attendance.sql'

test('regular agents default Team Attendance to the current New York work date', async () => {
  const script = await read('scripts/team-attendance.js')
  const functionSource = script.match(/function defaultAgentDateRange\(\) \{[\s\S]*?\n\}/)?.[0]

  assert.ok(functionSource, 'defaultAgentDateRange should remain independently testable')
  const defaultRangeFor = dateKey => Function(
    'localDateKey',
    `${functionSource}\nreturn defaultAgentDateRange()`
  )(() => dateKey)

  assert.deepEqual(defaultRangeFor('2026-08-01'), {
    start: '2026-08-01',
    end: '2026-08-01'
  })
  assert.match(script, /access\.is_admin === true[\s\S]*?defaultDateRange\(\)[\s\S]*?: defaultAgentDateRange\(\)/)
  assert.match(script, /access\?\.is_admin === true[\s\S]*?validateDateRange\(\)[\s\S]*?: defaultAgentDateRange\(\)/)
  assert.match(script, /elements\.startDate\.value = range\.start[\s\S]*?elements\.endDate\.value = range\.end/)
  assert.match(script, /if \(advancedFilters\) advancedFilters\.hidden = true/)
  assert.match(script, /if \(quickFilters\) quickFilters\.hidden = true/)
})

test('regular agents receive only the live attendance card surface', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /if \(isAdminView\) badges\.appendChild\(actionMenu\)/)
  assert.match(script, /if \(isAdminView\) \{[\s\S]*?card\.append\(stats, prepaid\)/)
  assert.match(script, /access\?\.is_admin === true[\s\S]*?workforce_list_team_attendance_prepaid/)
  assert.match(script, /Promise\.resolve\(\{ data: \[\], error: null \}\)/)
  assert.match(script, /including early clock-ins assigned to today's schedule/)
})

test('database keeps admin history and restricts agents to todays open scheduled sessions', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /v_is_admin[\s\S]*?attendance_row\.work_date between p_start_date and p_end_date/)
  assert.match(migration, /workforce_can_manage_user\([\s\S]*?'view_team_attendance'/)
  assert.match(migration, /not v_is_admin[\s\S]*?attendance_row\.clock_in is not null[\s\S]*?attendance_row\.clock_out is null/)
  assert.match(migration, /coalesce\(schedule\.shift_date, attendance_row\.work_date\) = v_today/)
  assert.doesNotMatch(migration, /clock_in::date\s*=\s*v_today/)
  assert.match(migration, /case when v_is_admin then attendance_row\.correction_reason else null end/)
  assert.match(migration, /revoke all on function public\.workforce_list_team_attendance\(date, date\)[\s\S]*?from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_list_team_attendance\(date, date\)[\s\S]*?to authenticated, service_role/)
})

test('Home exposes Team Attendance to active regular agents', async () => {
  const [home, navigation] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(home, /scripts\/home-workforce-nav\.js\?v=8/)
  assert.match(navigation, /access\.is_admin === true[\s\S]*?view_team_attendance[\s\S]*?: access\.is_agent === true/)
})
