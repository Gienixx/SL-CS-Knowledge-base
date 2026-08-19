import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function extractFunction(script, name) {
  const start = script.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} function is present`)
  const bodyStart = script.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1
    if (script[index] === '}') {
      depth -= 1
      if (depth === 0) return script.slice(start, index + 1)
    }
  }
  throw new Error(`Could not extract ${name}`)
}

function loadPaidLeaveEligibility(script, state) {
  return new Function(
    'adminAssistMode',
    'todaySchedules',
    'openAttendanceRecord',
    'localDateKey',
    'hasCompletedAttendanceForDate',
    `const PAID_VL_TYPES = Object.freeze(['incentive_vl', 'birthday_vl'])
     ${extractFunction(script, 'isSpecialDay')}
     ${extractFunction(script, 'isPaidVLSchedule')}
     ${extractFunction(script, 'paidLeaveWorkOptionEligible')}
     return paidLeaveWorkOptionEligible`
  )(
    state.adminAssistMode,
    state.todaySchedules,
    () => state.openAttendance,
    () => '2026-08-17',
    date => state.completedDates.includes(date)
  )
}

const paidVL = leave_type => ({
  id: `leave-${leave_type}`,
  shift_date: '2026-08-17',
  shift_sequence: 99,
  is_leave: true,
  is_absent: false,
  leave_type
})

test('paid VL dates expose a separate work option for Incentive and Birthday VL', async () => {
  const script = await read('scripts/attendance.js')

  for (const leave_type of ['incentive_vl', 'birthday_vl']) {
    assert.equal(loadPaidLeaveEligibility(script, {
      adminAssistMode: false,
      todaySchedules: [paidVL(leave_type)],
      openAttendance: null,
      completedDates: []
    })(), true)
  }

  assert.match(script, /WORK_ON_VL = '__WORK_ON_VL__'/)
  assert.match(script, /Work on VL · Needs review/)
  assert.match(script, /option\.disabled = true/)
  assert.match(script, /leaveScheduleOptionLabel/)
})

test('unpaid leave, absence, normal work schedules, open attendance, and completed work suppress Work on VL', async () => {
  const script = await read('scripts/attendance.js')
  const base = {
    adminAssistMode: false,
    openAttendance: null,
    completedDates: []
  }

  assert.equal(loadPaidLeaveEligibility(script, { ...base, todaySchedules: [paidVL('leave_without_pay')] })(), false)
  assert.equal(loadPaidLeaveEligibility(script, {
    ...base,
    todaySchedules: [paidVL('incentive_vl'), { shift_date: '2026-08-17', is_absent: true }]
  })(), false)
  assert.equal(loadPaidLeaveEligibility(script, {
    ...base,
    todaySchedules: [paidVL('incentive_vl'), {
      shift_date: '2026-08-17',
      is_leave: false,
      is_absent: false,
      shift_start: '2026-08-17T13:00:00.000Z',
      shift_end: '2026-08-17T21:00:00.000Z'
    }]
  })(), false)
  assert.equal(loadPaidLeaveEligibility(script, {
    ...base,
    todaySchedules: [paidVL('incentive_vl')],
    openAttendance: { id: 'open' }
  })(), false)
  assert.equal(loadPaidLeaveEligibility(script, {
    ...base,
    todaySchedules: [paidVL('incentive_vl')],
    completedDates: ['2026-08-17']
  })(), false)

  assert.match(script, /visibleSchedules = todaySchedules\.filter\(schedule => !schedule\.is_leave && !schedule\.is_absent\)/)
  assert.match(script, /const scheduleId = selectedValue === ADDITIONAL_WORK_SESSION \|\| workOnVLSelected \? null : selectedValue/)
  assert.match(script, /isWorkOnVLSelected\(\) && paidLeaveWorkOptionEligible\(\)/)
})

test('Work on VL uses the existing pending unscheduled attendance and payroll semantics', async () => {
  const [script, clockInMigration, paidLeaveMigration] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260813173636_allow_additional_unscheduled_attendance_session.sql'),
    read('supabase/migrations/20260810122937_correct_paid_leave_prepaid_independence.sql')
  ])

  assert.match(script, /workforce_clock_in', \{ p_schedule_id: scheduleId \}/)
  assert.match(clockInMigration, /values \(v_profile_user_id, p_schedule_id, v_work_date, v_clock_time, 'present', 'pending'/)
  assert.match(clockInMigration, /Only reuse an empty placeholder/)
  assert.match(clockInMigration, /v_has_completed_session/)
  assert.match(paidLeaveMigration, /v_minutes := 480/)
  assert.match(paidLeaveMigration, /prepaid_independent.*true/)
  assert.match(paidLeaveMigration, /premium_pay.*false/)
  assert.doesNotMatch(paidLeaveMigration, /(?:from|join) public\.payroll_prepaid_hours/)
})
