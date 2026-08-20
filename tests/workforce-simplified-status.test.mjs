import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('operational status is Published while Changed and Completed are independent tags', async () => {
  const [migration, helper, manager] = await Promise.all([
    read('supabase/migrations/20260820153000_simplify_workforce_schedule_status_model.sql'),
    read('shared/workforce-schedule-status.js'),
    read('scripts/workforce-schedules.js')
  ])

  assert.match(migration, /new\.status := 'published'/)
  assert.match(migration, /add column if not exists changed_at timestamptz/)
  assert.match(migration, /add column if not exists changed_by uuid/)
  assert.match(helper, /Published/)
  assert.match(helper, /Changed/)
  assert.match(helper, /Completed/)
  assert.match(manager, /scheduleStatusTags\(schedule, schedule\.attendance \|\| \[\]\)/)
  assert.doesNotMatch(manager, /id="scheduleStatus"/)
})

test('completed attendance derives a display tag without changing the schedule eligibility predicate', async () => {
  const [helper, attendance] = await Promise.all([
    read('shared/workforce-schedule-status.js'),
    read('scripts/attendance.js')
  ])

  const isCompleted = new Function(`${helper.replaceAll(/^export /gm, '')}; return isCompletedSchedule`)()
  const schedule = { id: 'overnight', status: 'published' }
  assert.equal(isCompleted(schedule, [{ schedule_id: 'overnight', clock_in: '2026-08-19T21:00:00-04:00', clock_out: '2026-08-20T05:00:00-04:00' }]), true)
  assert.equal(isCompleted(schedule, [{ schedule_id: 'overnight', clock_in: '2026-08-19T21:00:00-04:00', clock_out: null }]), false)
  assert.match(attendance, /const RELEASED_SCHEDULE_STATUSES = Object\.freeze\(\['published', 'changed'\]\)/)
  assert.match(attendance, /hasAttendanceForSchedule\(schedule\)/)
})

test('legacy data normalization preserves cancelled rows and refuses automatic draft normalization', async () => {
  const migration = await read('supabase/migrations/20260820153000_simplify_workforce_schedule_status_model.sql')

  assert.match(migration, /where status in \('changed', 'completed'\)/)
  assert.doesNotMatch(migration, /where status in \('scheduled', 'changed', 'completed'\)/)
  assert.match(migration, /scheduled row is a legacy draft/)
  assert.match(migration, /if tg_op = 'INSERT' then[\s\S]*?elsif old\.status is distinct from new\.status then/)
  assert.match(migration, /if new\.status <> 'cancelled'/)
  assert.match(migration, /Cancelled is not a selectable schedule status/)
})

test('production-shaped normalization preserves historical cancelled rows and is atomic for scheduled drafts', async () => {
  const migration = await read('supabase/migrations/20260820153000_simplify_workforce_schedule_status_model.sql')
  const fixture = [
    { status: 'published', automation_leave_cancelled: false, hasAudit: true },
    { status: 'changed', automation_leave_cancelled: false, hasAudit: true },
    { status: 'completed', automation_leave_cancelled: false, hasAudit: true, finishedAttendance: true },
    { status: 'cancelled', automation_leave_cancelled: false, hasAudit: true },
    { status: 'cancelled', automation_leave_cancelled: true, hasAudit: true }
  ]

  const triggerAllows = (oldRow, newRow, operation) => {
    if (newRow.status !== 'cancelled' || newRow.automation_leave_cancelled) return true
    if (operation === 'INSERT') return false
    return oldRow.status === newRow.status
  }

  const backfill = fixture.map(row => ({ ...row, changed_at: row.hasAudit ? 'audit-time' : null }))
  assert.equal(backfill.filter(row => row.status === 'cancelled').length, 2)
  assert.equal(backfill.filter(row => row.status === 'cancelled' && !triggerAllows(row, row, 'UPDATE')).length, 0)

  const normalized = backfill.map(row => ['changed', 'completed'].includes(row.status) ? { ...row, status: 'published' } : row)
  assert.deepEqual(normalized.map(row => row.status), ['published', 'published', 'published', 'cancelled', 'cancelled'])
  assert.equal(normalized.filter(row => row.status === 'published').length, 3)
  assert.equal(normalized.filter(row => row.status === 'cancelled').length, 2)
  assert.equal(normalized.filter(row => row.finishedAttendance).length, 1)

  assert.equal(triggerAllows(null, { status: 'cancelled', automation_leave_cancelled: false }, 'INSERT'), false)
  assert.equal(triggerAllows({ status: 'published' }, { status: 'cancelled', automation_leave_cancelled: false }, 'UPDATE'), false)
  assert.equal(triggerAllows({ status: 'cancelled' }, { status: 'cancelled', automation_leave_cancelled: false }, 'UPDATE'), true)
  assert.equal(triggerAllows({ status: 'cancelled' }, { status: 'cancelled', automation_leave_cancelled: true }, 'UPDATE'), true)

  assert.match(migration, /begin;[\s\S]*?commit;/)
  assert.match(migration, /if exists \(select 1 from public\.work_schedules where status = 'scheduled'\)/)
})

test('deletion permits only unreferenced schedules and never detaches historical links', async () => {
  const migration = await read('supabase/migrations/20260820153000_simplify_workforce_schedule_status_model.sql')

  for (const phrase of [
    'attendance history is linked',
    'correction history references it',
    'leave or absence history references it',
    'payroll history references it',
    'audit history references it'
  ]) assert.match(migration, new RegExp(phrase))

  assert.doesNotMatch(migration, /set schedule_id = null/)
  assert.doesNotMatch(migration, /detached_attendance_records/)
})
