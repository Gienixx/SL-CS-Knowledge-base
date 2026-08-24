import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260824090000_attendance_payroll_approval_state.sql'

test('attendance payroll approval is additive and does not redefine review or lock state', async () => {
  const [migration, originalProtection] = await Promise.all([
    read(migrationPath),
    read('supabase/migrations/20260717172240_attendance_approval_locking.sql')
  ])

  assert.match(migration, /add column if not exists payroll_approved_at timestamptz/)
  assert.match(migration, /review_status not in \('approved', 'locked'\)/)
  assert.match(migration, /v_attendance\.review_status <> 'approved'/)
  assert.match(migration, /if v_attendance\.review_status = 'locked'/)
  assert.match(migration, /Locked attendance cannot be changed\./)
  assert.match(migration, /Attendance must be approved before it can be locked\./)
  assert.match(originalProtection, /old\.review_status = 'locked'/)
  assert.match(originalProtection, /zz_attendance_locked_immutable/)
  assert.doesNotMatch(migration, /drop constraint[^\n]*attendance_review_status_check/i)
  assert.doesNotMatch(migration, /review_status.*payroll_approved_at.*locked/i)
})

test('approval sets the additive marker and locking preserves it', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /when p_review_status = 'approved'[\s\S]*then coalesce\(v_attendance\.payroll_approved_at, now\(\)\)/)
  assert.match(migration, /else v_attendance\.payroll_approved_at/)
  assert.match(migration, /'payroll_approved_at', v_attendance\.payroll_approved_at/)
  assert.match(migration, /'payroll_approved_at', v_result\.payroll_approved_at/)
})

test('correction and schedule reassignment clear approval while retaining existing reopen transitions', async () => {
  const migration = await read(migrationPath)

  assert.equal((migration.match(/payroll_approved_at = null/g) || []).length, 2)
  assert.match(migration, /workforce_assign_attendance_schedule\(uuid,uuid,text,text\)/)
  assert.match(migration, /workforce_correct_attendance\(uuid,timestamptz,timestamptz,text,uuid,text,text,text\)/)
  assert.match(migration, /review_status = case when review_status = ''approved'' then ''corrected'' else review_status end/)
  assert.match(migration, /review_status = ''corrected''/)
})

test('historical backfill requires current approval metadata or explicit approval audit evidence', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /log\.action = 'attendance_approved'/)
  assert.match(migration, /log\.after_data ->> 'review_status' = 'approved'/)
  assert.match(migration, /attendance_row\.review_status = 'approved'/)
  assert.match(migration, /attendance_row\.review_status = 'locked'/)
  assert.match(migration, /locked row alone is not proof/i)
  assert.doesNotMatch(migration, /where attendance_row\.review_status = 'locked'[\s\S]{0,120}set payroll_approved_at = attendance_row\.reviewed_at/)
})

test('Team Attendance listing exposes approval state only to administrators', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /payroll_approved_at timestamptz, corrected_by uuid/)
  assert.match(migration, /case when v_is_admin then attendance_row\.payroll_approved_at else null end/)
  assert.match(migration, /drop function public\.workforce_list_team_attendance\(date,date\)/)
})
