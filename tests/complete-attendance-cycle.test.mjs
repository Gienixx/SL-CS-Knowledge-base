import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const verificationPath = 'supabase/verification/complete_attendance_cycle_check.sql'
const documentationPath = 'docs/workforce-step-17-complete-attendance-cycle.md'
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 17 verification covers the complete required attendance cycle', async () => {
  const verification = await read(verificationPath)

  for (const result of [
    'normal_shift',
    'several_hours_early',
    'automatic_overtime_to_regular_transition',
    'post_shift_overtime',
    'combined_overtime',
    'overnight_shift',
    'multiple_shifts_one_work_date',
    'overlapping_session_rejected',
    'missing_clock_out_detected',
    'clock_in_correction',
    'clock_out_correction',
    'correction_reason_logged',
    'recalculation_after_correction',
    'attendance_approved',
    'leave_submitted_and_approved',
    'supervisor_team_visibility',
    'agent_self_record_isolation',
    'overtime_near_20_hours',
    'overtime_over_20_hours_capped'
  ]) {
    assert.match(verification, new RegExp(`'${result}'`))
  }
})

test('Step 17 is rollback-only and preserves recurring schedule automation', async () => {
  const verification = await read(verificationPath)

  assert.match(verification, /errcode = 'P1700'/)
  assert.match(verification, /message = 'step17_rollback'/)
  assert.match(verification, /work_schedule_templates/)
  assert.match(verification, /work_schedule_template_days/)
  assert.match(verification, /work_schedule_template_assignments/)
  assert.match(verification, /recurring_schedule_automation_preserved/)
  assert.doesNotMatch(verification, /workforce_generate_weekly_schedules\s*\(/)
  assert.doesNotMatch(verification, /workforce_admin_add_schedule_to_weekly_template\s*\(/)
})

test('Step 17 deployment evidence documents live safety boundaries', async () => {
  const documentation = await read(documentationPath)

  assert.match(documentation, /rollback-only/i)
  assert.match(documentation, /recurring schedule/i)
  assert.match(documentation, /production/i)
  assert.match(documentation, /Step 18/i)
})
