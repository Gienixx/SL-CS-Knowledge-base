import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('delete UI sends exact UUID and verifies the void before success', async () => {
  const script = await read('scripts/team-attendance.js')
  assert.match(script, /workforce_delete_attendance/)
  assert.match(script, /p_attendance_id: pending\.row\.attendance_id/)
  assert.match(script, /workforce_verify_attendance_void/)
  assert.match(script, /!verification\.data\?\.\[0\]\?\.voided_at/)
  assert.match(script, /Attendance record was not deleted\. Please try again or contact admin\./)
  assert.match(script, /row\.review_status === 'voided'/)
})

test('delete migration voids exact attendance id and guards the update', async () => {
  const migration = await read('supabase/migrations/20260814150000_harden_attendance_delete_and_verify.sql')
  for (const token of ['where id = v_attendance.id and voided_at is null', 'voided_at', 'voided_by', 'void_reason', 'updated_at', 'if not found then raise exception', 'workforce_verify_attendance_void', 'finalized payroll']) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  assert.doesNotMatch(migration, /delete from public\.attendance/i)
})

test('delete-related JavaScript is syntactically valid', () => {
  for (const file of ['scripts/team-attendance.js', 'scripts/attendance.js']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})
