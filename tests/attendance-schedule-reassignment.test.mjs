import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260818203928_allow_previous_day_attendance_schedule_reassignment.sql'

test('correction schedule choices include only the work date and previous calendar date', async () => {
  const script = await read('scripts/team-attendance.js')
  const functionSource = script.match(/function correctionScheduleDates\(workDate\) \{[\s\S]*?\n\}/)?.[0]

  assert.ok(functionSource)
  const correctionScheduleDates = Function(`${functionSource}\nreturn correctionScheduleDates`)()
  assert.deepEqual(correctionScheduleDates('2026-08-17'), ['2026-08-17', '2026-08-16'])
  assert.deepEqual(correctionScheduleDates('2026-03-01'), ['2026-03-01', '2026-02-28'])
  assert.match(script, /\.in\('shift_date', correctionScheduleDates\(row\.work_date\)\)/)
})

test('correction schedule labels identify date, type, sequence, and times', async () => {
  const [script, page] = await Promise.all([
    read('scripts/team-attendance.js'),
    read('team-attendance.html')
  ])

  for (const label of ['Work Schedule', 'Rest Day', 'Holiday', 'Sequence']) {
    assert.match(script, new RegExp(label))
  }
  assert.match(script, /function formatCorrectionScheduleLabel\(schedule\)/)
  assert.match(page, /id="teamAttendanceCorrectionSchedule"/)
  assert.match(page, /Required when billed time or assigned shift changes/)
})

test('schedule reassignment rejects older and future dates, leave, and absence schedules', async () => {
  const migration = await read(migrationPath)

  assert.equal((migration.match(/v_schedule\.shift_date not in \(v_old\.work_date, v_old\.work_date - 1\)/g) || []).length, 2)
  assert.equal((migration.match(/Leave and absence schedules cannot be assigned/g) || []).length, 2)
  assert.equal((migration.match(/Only published or changed schedules may be assigned/g) || []).length, 2)
})

test('schedule reassignment preserves existing permissions and locked attendance safeguards', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /workforce_current_user_is_active\(\)/)
  assert.match(migration, /workforce_can_correct_attendance\(public\.workforce_current_profile_id\(\)\)/)
  assert.equal((migration.match(/workforce_can_manage_user\(v_old\.user_id, 'correct_attendance'\)/g) || []).length, 1)
  assert.equal((migration.match(/Locked attendance cannot be changed/g) || []).length, 2)
  assert.match(migration, /grant execute on function public\.workforce_assign_attendance_schedule[\s\S]*to authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_correct_attendance[\s\S]*to authenticated/)
})

test('schedule reassignment records old and new schedule IDs, actor, reason, time, and recalculates', async () => {
  const migration = await read(migrationPath)

  assert.equal((migration.match(/previous_schedule_id, new_schedule_id/g) || []).length, 2)
  assert.equal((migration.match(/v_old\.schedule_id, v_new\.schedule_id/g) || []).length, 2)
  assert.equal((migration.match(/v_new := public\.workforce_recalculate_attendance\(v_new\.id\)/g) || []).length, 2)
  assert.equal((migration.match(/original_clock_in/g) || []).length >= 4, true)
  assert.equal((migration.match(/corrected_by, corrected_at/g) || []).length, 2)
  assert.match(migration, /attendance_schedule_assigned/)
  assert.match(migration, /attendance_billed_time_corrected/)
  assert.match(migration, /coalesce\(v_reason, p_reason_code\)/)
  assert.match(migration, /v_schedule\.shift_date not in \(v_attendance\.work_date, v_attendance\.work_date - 1\)/)
  assert.match(migration, /case when v_attendance\.schedule_id is null then v_attendance\.work_date else v_schedule\.shift_date end/)
})

test('the correction modal uses the audited assignment path for schedule-only changes', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /const scheduleOnlyChange = scheduleChanged && !billedTimeChanged/)
  assert.match(script, /scheduleOnlyChange[\s\S]*workforce_assign_attendance_schedule/)
  assert.match(script, /p_schedule_id: scheduleId \|\| null/)
  assert.match(script, /row\.original_clock_in \|\| row\.clock_in/)
  assert.match(script, /row\.original_clock_out \|\| row\.clock_out/)
})
