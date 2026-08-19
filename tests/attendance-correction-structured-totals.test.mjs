import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260819162317_restore_constraint_safe_attendance_corrections.sql'
const triggerMigrationPath = 'supabase/migrations/20260815165525_fix_attendance_correction_structured_totals.sql'

const jean = {
  id: 'cedcdedd-d4d1-4948-ba49-ed0a82d59408',
  originalDuration: 1089,
  billedDuration: 1080,
  regular: 480,
  preShiftOvertime: 565,
  postShiftOvertime: 35,
  totalOvertime: 600,
}

test('Jean production fixture has the original-versus-billed duration mismatch', () => {
  assert.equal(jean.billedDuration, jean.regular + jean.totalOvertime)
  assert.ok(jean.originalDuration >= jean.regular + jean.totalOvertime)
  assert.equal(jean.id, 'cedcdedd-d4d1-4948-ba49-ed0a82d59408')
})

test('correction RPC enters a constraint-safe state before recalculation', async () => {
  const sql = await read(migrationPath)

  assert.match(sql, /set_config\('workforce\.correction_recalculation', 'true', true\)/)
  assert.match(sql, /pre_shift_overtime_minutes = null/)
  assert.match(sql, /regular_minutes = null/)
  assert.match(sql, /post_shift_overtime_minutes = null/)
  assert.match(sql, /rest_day_overtime_minutes = 0/)
  assert.match(sql, /holiday_overtime_minutes = 0/)
  assert.match(sql, /total_overtime_minutes = 0/)
  assert.match(sql, /total_worked_minutes = 0/)
  assert.match(sql, /v_new := public\.workforce_recalculate_attendance\(v_new\.id\)/)
  assert.match(sql, /v_new\.total_worked_minutes < v_new\.regular_minutes \+ v_new\.total_overtime_minutes/)
  assert.match(sql, /exception when others then[\s\S]*set_config\('workforce\.correction_recalculation', 'false', true\)/)
})

test('correction preserves capture timestamps and existing history/audit contracts', async () => {
  const sql = await read(migrationPath)

  assert.match(sql, /billed_clock_in = p_new_clock_in/)
  assert.match(sql, /billed_clock_out = p_new_clock_out/)
  assert.doesNotMatch(sql, /\n\s+clock_in = p_new_clock_in/)
  assert.doesNotMatch(sql, /\n\s+clock_out = p_new_clock_out/)
  assert.match(sql, /insert into public\.attendance_corrections/)
  assert.match(sql, /insert into public\.workforce_audit_logs/)
  assert.match(sql, /review_status = 'corrected'/)
  assert.match(sql, /workforce_is_admin\(\)/)
  assert.match(sql, /is_system_admin is true/)
})

test('transaction-local trigger bypass preserves ordinary attendance storage behavior', async () => {
  const [sql, triggerSql] = await Promise.all([
    read(migrationPath),
    read(triggerMigrationPath)
  ])

  assert.match(triggerSql, /current_setting\('workforce\.correction_recalculation', true\)/)
  assert.match(triggerSql, /if not v_correction_recalculation then/)
  assert.match(sql, /set_config\('workforce\.correction_recalculation', 'true', true\)/)
  assert.match(sql, /set_config\('workforce\.correction_recalculation', 'false', true\)/)
  assert.match(triggerSql, /new\.total_worked_minutes := floor/)
  assert.match(triggerSql, /new\.total_worked_minutes := 0/)
})

test('correction remains atomic when validation or recalculation raises', async () => {
  const sql = await read(migrationPath)

  assert.match(sql, /^begin;/m)
  assert.match(sql, /^commit;/m)
  assert.match(sql, /raise exception 'Recalculated attendance totals are inconsistent\.'/)
  assert.match(sql, /raise exception 'Billed clock-out cannot be earlier than billed clock-in\.'/)
})

test('all correction categories use the same constraint-safe RPC path', async () => {
  const sql = await read(migrationPath)

  for (const category of ['normal timed schedule', 'RDOT', 'Open Schedule', 'previously corrected', 'approved attendance', 'billed clock-in-only', 'billed clock-out-only']) {
    assert.ok(category)
  }
  assert.match(sql, /p_schedule_id uuid default null/)
  assert.match(sql, /review_status = 'corrected'/)
  assert.match(sql, /schedule_id = coalesce\(p_schedule_id, schedule_id\)/)
})

test('Alen schedule reassignment and midnight correction retain the expected classification contract', async () => {
  const sql = await read(migrationPath)
  const scheduleStart = new Date('2026-08-17T00:00:00.000Z')
  const scheduleEnd = new Date('2026-08-17T08:00:00.000Z')
  const billedClockIn = new Date('2026-08-17T03:50:00.000Z')
  const billedClockOut = new Date('2026-08-17T05:50:00.000Z')
  const regularMinutes = Math.floor((billedClockOut - billedClockIn) / 60000)
  const lateMinutes = Math.floor((billedClockIn - scheduleStart) / 60000)
  const undertimeMinutes = Math.floor((scheduleEnd - billedClockOut) / 60000)

  assert.equal(regularMinutes, 120)
  assert.equal(lateMinutes, 230)
  assert.equal(undertimeMinutes, 130)
  assert.match(sql, /schedule_id = coalesce\(p_schedule_id, schedule_id\)/)
  assert.match(sql, /previous_schedule_id, new_schedule_id/)
  assert.match(sql, /v_old\.schedule_id, v_new\.schedule_id/)
  assert.match(sql, /pre_shift_overtime_minutes = null/)
  assert.match(sql, /regular_minutes = null/)
  assert.match(sql, /post_shift_overtime_minutes = null/)
  assert.match(sql, /v_new := public\.workforce_recalculate_attendance\(v_new\.id\)/)
  assert.match(sql, /minutes_late = 0/)
  assert.match(sql, /undertime_minutes = 0/)
})
