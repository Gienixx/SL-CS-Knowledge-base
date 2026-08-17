import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath = 'supabase/migrations/20260817063458_attendance_open_session_over_duration_review_production_forward.sql'

test('open-session duration boundary is strict and never closes the session', async () => {
  const [script, attendanceScript] = await Promise.all([
    read('scripts/team-attendance.js'),
    read('scripts/attendance.js')
  ])
  const durationSource = script.match(/function durationMinutes\(clockIn, clockOut\) \{[\s\S]*?\n\}/)?.[0]
  const limitSource = script.match(/function hasExceededOpenSessionLimit\(clockIn, now = new Date\(\)\) \{[\s\S]*?\n\}/)?.[0]
  const classifySource = script.match(/function classifyOpenSession\(record, now = new Date\(\)\) \{[\s\S]*?\n\}/)?.[0]

  assert.ok(durationSource)
  assert.ok(limitSource)
  assert.ok(classifySource)
  const classify = Function(
    'durationMinutes',
    'OPEN_SESSION_LIMIT_MINUTES',
    `${durationSource}\n${limitSource}\n${classifySource}\nreturn classifyOpenSession`
  )(null, 20 * 60)

  const clockIn = new Date(Date.UTC(2026, 7, 12, 12, 0, 0))
  const record = { original_clock_in: clockIn.toISOString(), original_clock_out: null, is_missing_clock_out: false }
  const at = minutes => new Date(clockIn.getTime() + minutes * 60000)

  assert.deepEqual(classify(record, at(19 * 60 + 59)), {
    is_open: true,
    is_missing_clock_out: false,
    is_over_duration: false
  })
  assert.deepEqual(classify(record, at(20 * 60)), {
    is_open: true,
    is_missing_clock_out: false,
    is_over_duration: false
  })
  assert.deepEqual(classify(record, at(20 * 60 + 1)), {
    is_open: true,
    is_missing_clock_out: false,
    is_over_duration: true
  })
  assert.match(attendanceScript, /confirmClockOutIfNeeded/)
  assert.match(attendanceScript, /maybePersistOverDurationFlag\(record, now\)/)
  assert.match(attendanceScript, /workforce_flag_current_open_attendance_over_duration/)
  assert.match(attendanceScript, /\.rpc\('workforce_clock_out'/)
})

test('over-duration review is durable, strict, idempotent, and timestamp-neutral', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /add column if not exists manager_review_reason text/)
  assert.match(migration, /manager_review_reason = 'open_session_over_20_hours'/)
  assert.match(migration, /manager_review_reason is null/)
  assert.match(migration, /clock_in < v_now - interval '20 hours'/)
  assert.match(migration, /create or replace function public\.workforce_flag_current_open_attendance_over_duration\(\)/)
  assert.match(migration, /grant execute on function public\.workforce_flag_current_open_attendance_over_duration\(\) to authenticated/)
  assert.doesNotMatch(migration, /set[\s\S]*manager_review_reason[\s\S]*clock_out\s*=/)
  assert.match(migration, /manager_review_reason text\s*\n\)/)
  assert.match(migration, /attendance_row\.clock_in is not null and attendance_row\.clock_out is null/)
  assert.match(migration, /case when v_is_admin then attendance_row\.manager_review_reason else null end/)
  assert.match(migration, /to_jsonb\(new\) - array\['manager_review_reason', 'attendance_version', 'updated_at'\]/)
})

test('Team Attendance keeps an over-duration row open and surfaces the durable review indicator', async () => {
  const [script, migration] = await Promise.all([
    read('scripts/team-attendance.js'),
    read(migrationPath)
  ])

  assert.match(script, /is_over_duration: record\.manager_review_reason === 'open_session_over_20_hours'/)
  assert.match(script, /if \(row\.is_over_duration\) labels\.push\(\{ label: 'Over 20h · Review'/)
  assert.match(script, /if \(record\.is_over_duration\) return \{ label: 'Over 20h · Review'/)
  assert.match(script, /if \(attendanceQuickFilter === 'review'[\s\S]*!row\.is_over_duration/)
  assert.match(migration, /manager_review_reason text/)
  assert.match(migration, /update public\.attendance[\s\S]*manager_review_reason is null[\s\S]*clock_in < v_now - interval '20 hours'/)
  assert.match(migration, /attendance_row\.clock_in is not null and attendance_row\.clock_out is null,/)
})

test('existing clock-in paths and safeguards remain wired to the trusted RPCs', async () => {
  const [attendance, payrollReadiness, clockOutMigration] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260722084820_harden_attendance_payroll_readiness.sql'),
    read('supabase/migrations/20260721112529_fix_clock_out_structured_totals.sql')
  ])

  assert.match(attendance, /SCHEDULE_PLACEHOLDER = '__SCHEDULE_PLACEHOLDER__'/)
  assert.match(attendance, /ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'/)
  assert.match(attendance, /\.rpc\('workforce_clock_in'/)
  assert.match(attendance, /\.rpc\('workforce_clock_out'/)
  assert.match(attendance, /elements\.clockInButton\.disabled = busy \|\| Boolean\(openRecord\)/)
  assert.match(attendance, /isUntimedRestDayWithinClockInWindow/)
  assert.match(payrollReadiness, /review_required/)
  assert.match(payrollReadiness, /attendance_overtime_limit_exceeded/)
  assert.match(clockOutMigration, /Clock-out cannot be earlier than clock-in\./)
  assert.match(clockOutMigration, /return public\.workforce_recalculate_attendance\(v_result\.id\)/)
})
