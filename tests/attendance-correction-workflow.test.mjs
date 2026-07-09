import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const workflowPath = 'supabase/migrations/2026070904_attendance_correction_workflow.sql'
const guardPath = 'supabase/migrations/2026070905_attendance_original_timestamp_guard.sql'

test('correction workflow accepts only the approved reason codes', async () => {
  const migration = await read(workflowPath)

  for (const reason of [
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ]) {
    assert.match(migration, new RegExp(`'${reason}'`))
  }

  assert.match(migration, /v_reason_code = 'other' and v_reason_notes is null/)
  assert.match(migration, /Written notes are required when the correction reason is Other/)
})

test('correction workflow validates status, times, schedule ownership, and work date', async () => {
  const migration = await read(workflowPath)

  assert.match(migration, /p_attendance_status not in \('present', 'absent', 'on_leave', 'excused'\)/)
  assert.match(migration, /Present attendance requires an effective clock-in/)
  assert.match(migration, /Clock-out cannot be earlier than clock-in/)
  assert.match(migration, /Selected schedule belongs to another employee/)
  assert.match(migration, /Selected schedule must preserve the attendance work date/)
  assert.match(migration, /Another attendance record is already linked to the selected schedule/)
  assert.match(migration, /Another unscheduled attendance record already exists for this work date/)
  assert.match(migration, /Corrected attendance cannot overlap another attendance session/)
})

test('correction approval remains independent from correction permission', async () => {
  const migration = await read(workflowPath)

  assert.match(migration, /workforce_can_correct_attendance\(v_target_user_id\)/)
  assert.match(migration, /workforce_can_approve_attendance\(v_attendance\.user_id\)/)
  assert.match(migration, /then 'approved'/)
  assert.match(migration, /else 'corrected'/)
  assert.doesNotMatch(migration, /manage_payroll/)
})

test('correction recalculates the entire work date and records before and after values', async () => {
  const migration = await read(workflowPath)

  assert.match(migration, /v_before := to_jsonb\(v_attendance\)/)
  assert.match(migration, /workforce_recalculate_attendance_work_date/)
  assert.match(migration, /workforce_recalculate_attendance\(v_attendance\.id\)/)
  assert.match(migration, /v_after := to_jsonb\(v_result\)/)
  assert.match(migration, /'attendance_corrected'/)
  assert.match(migration, /'auto_approved'/)
})

test('authenticated clients lose direct attendance write privileges', async () => {
  const migration = await read(workflowPath)

  assert.match(migration, /revoke insert, update, delete on public\.attendance from authenticated/)
  assert.match(migration, /grant select on public\.attendance to authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_correct_attendance/)
})

test('original timestamp guard distinguishes correction actions from later clock actions', async () => {
  const migration = await read(guardPath)

  assert.match(migration, /v_is_correction_action boolean/)
  assert.match(migration, /new\.corrected_at is distinct from old\.corrected_at/)
  assert.match(migration, /and not v_is_correction_action/)
  assert.match(migration, /v_has_correction_metadata/)
  assert.match(migration, /or v_has_correction_metadata/)
  assert.match(migration, /original_clock_in is immutable after capture/)
  assert.match(migration, /original_clock_out is immutable after capture/)
})

test('Step 12 includes deployment verification and documents the Step 13 boundary', async () => {
  const verification = await read('supabase/verification/attendance_correction_workflow_check.sql')
  const documentation = await read('docs/workforce-step-12-attendance-corrections.md')

  assert.match(verification, /Every blocker query in section 6 must return zero rows/)
  assert.match(verification, /authenticated_can_update_attendance_should_be_false/)
  assert.match(documentation, /Step 13 must add `attendance_corrections`/)
  assert.match(documentation, /2026070904_attendance_correction_workflow\.sql/)
  assert.match(documentation, /2026070905_attendance_original_timestamp_guard\.sql/)
})
