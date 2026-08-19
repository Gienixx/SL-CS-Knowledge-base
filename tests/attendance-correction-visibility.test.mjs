import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { redactAttendanceCorrectionForViewer } from '../shared/workforce-access.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const attendanceId = '7f53390c-ba7e-41c4-b5a9-3dab6c69ff20'
const correction = {
  attendance_id: attendanceId,
  clock_out: null,
  is_corrected: true,
  review_status: 'corrected',
  corrected_by: '7859dcc5-7a77-4850-bc91-1db5d9e0dd90',
  corrected_by_name: 'admin',
  corrected_at: '2026-08-01T04:54:00.000Z',
  correction_reason: 'manager_confirmed',
  admin_notes: null
}

test('Arby August 1 correction details are hidden from agents and regular admins', () => {
  for (const access of [
    { is_admin: false, is_system_admin: false },
    { is_admin: true, is_system_admin: false }
  ]) {
    const visibleRecord = redactAttendanceCorrectionForViewer(access, correction)

    assert.equal(visibleRecord.is_corrected, false)
    assert.equal(visibleRecord.review_status, 'pending')
    assert.equal(visibleRecord.corrected_by, null)
    assert.equal(visibleRecord.corrected_by_name, null)
    assert.equal(visibleRecord.corrected_at, null)
    assert.equal(visibleRecord.correction_reason, null)
    assert.equal(visibleRecord.admin_notes, null)
  }
})

test('Arby August 1 correction details remain visible to system admins', () => {
  assert.equal(
    redactAttendanceCorrectionForViewer({ is_system_admin: true }, correction),
    correction
  )
})

test('correction visibility exception is applied to both attendance views', async () => {
  const [agentScript, teamScript, agentPage, teamPage] = await Promise.all([
    read('scripts/attendance.js'),
    read('scripts/team-attendance.js'),
    read('attendance.html'),
    read('team-attendance.html')
  ])

  assert.match(agentScript, /redactAttendanceCorrectionForViewer\(access, record\)/)
  assert.match(teamScript, /redactAttendanceCorrectionForViewer\(access,/)
   assert.match(agentPage, /scripts\/attendance\.js\?v=26/)
   assert.match(teamPage, /scripts\/team-attendance\.js\?v=26/)
})
