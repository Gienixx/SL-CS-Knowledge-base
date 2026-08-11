import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Team Attendance labels correction action Edit and leaves approved records enabled', async () => {
  const script = await read('scripts/team-attendance.js')
  assert.match(script, /textContent = row\.schedule_id \? 'Edit' : 'Assign Schedule'/)
  assert.match(script, /row\.review_status === 'locked'/)
  assert.doesNotMatch(script, /\['approved', 'locked'\]\.includes\(row\.review_status\)/)
})

test('approved attendance reopens through the audited billed correction workflow', async () => {
  const sql = await read('supabase/migrations/20260810130000_allow_system_admin_approved_attendance_edit.sql')
  assert.match(sql, /profile\.is_system_admin is true/)
  assert.match(sql, /if v_old\.review_status = 'locked'/)
  assert.match(sql, /review_status = 'corrected'/)
  assert.match(sql, /original_clock_in/)
  assert.match(sql, /billed_clock_in = p_new_clock_in/)
  assert.match(sql, /A correction reason is required/)
  assert.match(sql, /insert into public\.attendance_corrections/)
  assert.match(sql, /attendance_version/)
  assert.match(sql, /attendance_billed_time_corrected/)
})
