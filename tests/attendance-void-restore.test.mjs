import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260819183555_void_attendance_operational_restore.sql'

test('voided attendance is excluded from agent operational reads and eligibility', async () => {
  const [attendanceScript, logMigration, clockInMigration] = await Promise.all([
    read('scripts/attendance.js'),
    read(migrationPath),
    read('supabase/migrations/20260813220325_exclude_voided_team_attendance.sql')
  ])

  assert.match(attendanceScript, /\.from\('attendance'\)[\s\S]*?\.is\('voided_at', null\)/)
  assert.match(logMigration, /workforce_list_my_attendance_log\(date,date\)/)
  assert.match(logMigration, /attendance_row\.voided_at is null/)
  assert.match(logMigration, /workforce_admin_assist_snapshot\(uuid,date,date\)/)
  assert.match(logMigration, /workforce_clock_in\(uuid\)/)
  assert.match(clockInMigration, /attendance_row\.voided_at is null/)
  assert.match(logMigration, /workforce_list_voided_team_attendance/)
  assert.match(logMigration, /workforce_restore_attendance/)
})

test('active uniqueness and open-session safeguards ignore voided rows only', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create unique index public\.attendance_user_schedule_unique[\s\S]*where schedule_id is not null and voided_at is null/)
  assert.match(migration, /create unique index public\.attendance_one_open_session_per_user_idx[\s\S]*where clock_in is not null and clock_out is null and voided_at is null/)
  assert.match(migration, /workforce_clock_out\(text,uuid,uuid\)[\s\S]*attendance_row\.voided_at is null/)
  assert.match(migration, /workforce_admin_assist_clock_out\(uuid,text\)[\s\S]*voided_at is null/)
  assert.match(migration, /workforce_assign_attendance_schedule\(uuid,uuid,text,text\)[\s\S]*v_old\.voided_at is not null/)
  assert.match(migration, /workforce_correct_attendance\(uuid,timestamptz,timestamptz,text,uuid,text,text,text\)[\s\S]*v_old\.voided_at is not null/)
  assert.match(migration, /workforce_recalculate_attendance\(uuid\)[\s\S]*v_attendance\.voided_at is not null[\s\S]*return v_attendance/)
  assert.match(migration, /workforce_recalculate_attendance_work_date\(uuid,date\)[\s\S]*attendance_row\.voided_at is null/)
})

test('restore requires authorization, reason, conflict/payroll checks, and audit', async () => {
  const migration = await read(migrationPath)

  for (const token of [
    "workforce_is_admin()",
    "workforce_has_permission('manage_schedules')",
    "workforce_has_permission('correct_attendance')",
    'length(v_reason) < 3',
    'v_old.voided_at is null',
    'v_old.schedule_id is not null',
    'linked schedule no longer exists',
    'linked schedule is a leave or absence schedule',
    "v_schedule.status not in ('published', 'changed', 'completed')",
    "record.status = 'finalized'",
    "period.status = 'finalized'",
    'other_attendance.schedule_id = v_old.schedule_id',
    'other_attendance.voided_at is null',
    "'attendance_restored'",
    'voided_at = null',
    'voided_by = null',
    'void_reason = null',
    'workforce_recalculate_attendance(v_result.id)'
  ]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))

  assert.doesNotMatch(migration, /delete\s+from\s+public\.attendance/i)
})

test('payroll and schedule-side consumers exclude voided attendance', async () => {
  const migration = await read(migrationPath)

  for (const token of [
    'payroll_assert_ready_for_approval(uuid)',
    'payroll_get_period_attendance_import_status(uuid)',
    'payroll_import_attendance(uuid,uuid)',
    'workforce_reject_attended_leave_schedule()',
    'attendance_row.voided_at is null'
  ]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
})

test('voided history is admin-only and restore has a dedicated UI path', async () => {
  const [migration, page, script] = await Promise.all([
    read(migrationPath),
    read('team-attendance.html'),
    read('scripts/team-attendance.js')
  ])

  assert.match(migration, /workforce_list_voided_team_attendance/)
  assert.match(migration, /not public\.workforce_is_admin\(\)/)
  assert.match(migration, /workforce_can_manage_user\(\s*attendance_row\.user_id,\s*'view_team_attendance'/)
  assert.match(page, /id="teamAttendanceVoidedHistory"/)
  assert.match(page, /teamAttendanceRestoreModal/)
  assert.match(script, /workforce_list_voided_team_attendance/)
  assert.match(script, /workforce_restore_attendance/)
  assert.match(script, /teamAttendanceRestoreForm/)
  assert.match(script, /showVoidedHistory \? createVoidedAttendanceCard/)
  assert.match(page, /scripts\/team-attendance\.js\?v=26/)
})

test('voided and non-voided listing behavior remains explicit', async () => {
  const [migration, existingVisibility, page] = await Promise.all([
    read(migrationPath),
    read('supabase/migrations/20260813220325_exclude_voided_team_attendance.sql'),
    read('team-attendance.html')
  ])

  assert.match(migration, /where attendance_row\.work_date between p_start_date and p_end_date[\s\S]*attendance_row\.voided_at is not null/)
  assert.match(existingVisibility, /attendance_row\.voided_at is null/)
  assert.match(page, /Voided history/)
})

test('void/restore JavaScript is syntactically valid', async () => {
  for (const file of ['scripts/attendance.js', 'scripts/team-attendance.js']) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})
