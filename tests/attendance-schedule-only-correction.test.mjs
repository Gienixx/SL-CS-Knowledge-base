import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260819175337_harden_schedule_only_attendance_correction.sql'

test('schedule-only reassignment uses the constraint-safe correction sequence', async () => {
  const sql = await read(migrationPath)

  assert.match(sql, /create or replace function public\.workforce_assign_attendance_schedule\(/)
  assert.match(sql, /set_config\('workforce\.correction_recalculation', 'true', true\)/)
  for (const field of [
    'pre_shift_overtime_minutes = null',
    'regular_minutes = null',
    'post_shift_overtime_minutes = null',
    'rest_day_overtime_minutes = 0',
    'holiday_overtime_minutes = 0',
    'total_overtime_minutes = 0',
    'total_worked_minutes = 0',
    'minutes_late = 0',
    'undertime_minutes = 0'
  ]) assert.match(sql, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(sql, /v_new := public\.workforce_recalculate_attendance\(v_new\.id\)/)
  assert.match(sql, /raise exception 'Recalculated attendance totals are inconsistent\.'/)
  assert.match(sql, /exception when others then[\s\S]*set_config\('workforce\.correction_recalculation', 'false', true\)/)
  assert.match(sql, /schedule_id = p_schedule_id/)
  assert.match(sql, /review_status = case when review_status = 'approved' then 'corrected' else review_status end/)
  assert.match(sql, /insert into public\.attendance_corrections/)
  assert.match(sql, /'attendance_schedule_assigned'/)
  assert.match(sql, /grant execute on function public\.workforce_assign_attendance_schedule\(uuid, uuid, text, text\) to authenticated, service_role/)
  assert.doesNotMatch(sql, /clock_in\s*=\s*p_new_clock_in/)
})

test('Alen-style schedule reassignment preserves the expected 120-minute result contract', () => {
  const scheduleStart = new Date('2026-08-17T00:00:00.000Z')
  const scheduleEnd = new Date('2026-08-17T08:00:00.000Z')
  const billedClockIn = new Date('2026-08-17T03:50:00.000Z')
  const billedClockOut = new Date('2026-08-17T05:50:00.000Z')

  assert.equal((billedClockOut - billedClockIn) / 60000, 120)
  assert.equal((billedClockIn - scheduleStart) / 60000, 230)
  assert.equal((scheduleEnd - billedClockOut) / 60000, 130)

  const afternoonBilledClockOut = new Date('2026-08-17T17:50:00.000Z')
  assert.equal((afternoonBilledClockOut - scheduleEnd) / 60000, 590)
  assert.equal((afternoonBilledClockOut - billedClockIn) / 60000, 840)
})

test('Team Attendance keeps non-voided sub-minute records visible and excludes voided rows only', async () => {
  const sql = await read('supabase/migrations/20260813220325_exclude_voided_team_attendance.sql')

  assert.match(sql, /where attendance_row\.work_date between p_start_date and p_end_date[\s\S]*attendance_row\.voided_at is null/)
  assert.doesNotMatch(sql, /where[\s\S]*total_worked_minutes\s*[<>=]/i)
  assert.doesNotMatch(sql, /where[\s\S]*clock_out\s*>\s*clock_in/i)
})
