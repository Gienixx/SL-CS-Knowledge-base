import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  effectiveAttendanceClocks,
  formatAttendanceTimestamp,
  hasBilledOverride
} from '../shared/attendance-billed-timestamps.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const original = {
  clock_in: '2026-08-20T01:00:00.000Z',
  clock_out: '2026-08-20T09:00:00.000Z',
  original_clock_in: '2026-08-20T01:00:00.000Z',
  original_clock_out: '2026-08-20T09:00:00.000Z',
  billed_clock_in: '2026-08-20T01:00:00.000Z',
  billed_clock_out: '2026-08-20T09:00:00.000Z'
}

test('Attendance Log replaces payroll columns with billed timestamp columns in order', async () => {
  const [page, script] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js')
  ])

  const table = page.match(/<table class="wf-table attendance-table">[\s\S]*?<\/table>/)?.[0] || ''
  const headers = [...table.matchAll(/<th>([^<]+)<\/th>/g)].map(match => match[1])
  assert.deepEqual(headers, [
    'Date',
    'Assigned Shift',
    'Clock In',
    'Clock Out',
    'Worked',
    'Status',
    'Billed Clock In',
    'Billed Clock Out',
    'Notes'
  ])
  assert.doesNotMatch(page, /<th>(Pay Type|Adjustments)<\/th>/)
  assert.match(script, /attendance-billed-timestamps\.js/)
  assert.match(script, /formatAttendanceTimestamp/)
  assert.match(script, /hasBilledOverride/)
})

test('no correction keeps billed display on Team Attendance fallback rules', () => {
  assert.equal(hasBilledOverride(original), false)
  assert.deepEqual(effectiveAttendanceClocks(original), {
    renderedClockIn: original.original_clock_in,
    renderedClockOut: original.original_clock_out,
    billedClockIn: original.original_clock_in,
    billedClockOut: original.original_clock_out
  })
})

test('corrected billed clock-in, clock-out, or both are displayed without changing originals', () => {
  const cases = [
    {
      billed_clock_in: '2026-08-20T01:15:00.000Z',
      billed_clock_out: original.billed_clock_out
    },
    {
      billed_clock_in: original.billed_clock_in,
      billed_clock_out: '2026-08-20T08:45:00.000Z'
    },
    {
      billed_clock_in: '2026-08-20T01:15:00.000Z',
      billed_clock_out: '2026-08-20T08:45:00.000Z'
    }
  ]

  for (const correction of cases) {
    const record = { ...original, ...correction, is_corrected: true }
    const clocks = effectiveAttendanceClocks(record)
    assert.equal(hasBilledOverride(record), true)
    assert.equal(clocks.renderedClockIn, original.original_clock_in)
    assert.equal(clocks.renderedClockOut, original.original_clock_out)
    assert.equal(record.original_clock_in, original.original_clock_in)
    assert.equal(record.original_clock_out, original.original_clock_out)
    assert.equal(clocks.billedClockIn, correction.billed_clock_in)
    assert.equal(clocks.billedClockOut, correction.billed_clock_out)
  }
})

test('billed timestamp formatting uses the Team Attendance timezone and formatter', () => {
  const value = '2026-08-20T01:15:00.000Z'
  const expected = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
  assert.equal(formatAttendanceTimestamp(value), expected)
  assert.equal(formatAttendanceTimestamp(null), '—')
})

test('agent attendance RPC returns original and billed fields from the attendance source row', async () => {
  const migration = await read('supabase/migrations/20260821120000_expose_billed_attendance_in_agent_log.sql')

  for (const field of [
    'original_clock_in',
    'original_clock_out',
    'billed_clock_in',
    'billed_clock_out'
  ]) {
    assert.match(migration, new RegExp(`attendance_row\\.${field}`))
  }
  assert.match(migration, /attendance_row\.user_id = v_employee_id/)
  assert.match(migration, /attendance_row\.voided_at is null/)
  assert.match(migration, /revoke all on function public\.workforce_list_my_attendance_log\(date, date\)/)
  assert.match(migration, /grant execute on function public\.workforce_list_my_attendance_log\(date, date\)[\s\S]*to authenticated, service_role/)
})

test('prepaid Attendance Log rows only suppress duplicates for active attendance', async () => {
  const migration = await read('supabase/migrations/20260821120000_expose_billed_attendance_in_agent_log.sql')
  const duplicateCheck = migration.match(/and not exists \([\s\S]*?\n\s*\)\n\s*\)/)?.[0] || ''

  assert.match(duplicateCheck, /attendance_row\.user_id = v_employee_id/)
  assert.match(duplicateCheck, /attendance_row\.voided_at is null/)
  assert.match(duplicateCheck, /attendance_row\.schedule_id = snapshot\.schedule_id/)
  assert.match(duplicateCheck, /attendance_row\.work_date = snapshot\.work_date/)

  const suppressesPrepaidDuplicate = (attendance, snapshot) => (
    attendance.user_id === snapshot.employee_id
      && attendance.voided_at === null
      && attendance.schedule_id === snapshot.schedule_id
      && attendance.work_date === snapshot.work_date
  )
  const snapshot = {
    employee_id: 'agent-1',
    schedule_id: 'schedule-1',
    work_date: '2026-08-20'
  }

  assert.equal(suppressesPrepaidDuplicate({ ...snapshot, user_id: 'agent-1', voided_at: null }, snapshot), true)
  assert.equal(suppressesPrepaidDuplicate({ ...snapshot, user_id: 'agent-1', voided_at: '2026-08-21T00:00:00Z' }, snapshot), false)
  assert.equal(suppressesPrepaidDuplicate({ ...snapshot, user_id: 'agent-1', voided_at: null, work_date: '2026-08-21' }, snapshot), false)
})
