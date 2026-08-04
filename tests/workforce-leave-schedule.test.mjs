import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('create and edit schedule expose Leave as an exclusive non-working type', async () => {
  const [html, client] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-schedules.js')
  ])

  assert.match(html, /id="scheduleIsLeave"/)
  assert.match(html, /<span>Mark as leave<\/span>/)
  assert.doesNotMatch(html, /not yet linked to a leave request|Leave-request linking will be added later/)
  assert.match(client, /const leaveInput = document\.getElementById\('scheduleIsLeave'\)/)
  assert.match(client, /const hasNoFixedTimes = isRestDay \|\| isLeave \|\| isOpenSchedule/)
  assert.match(client, /selectedInput === leaveInput[\s\S]*restDayInput\.checked = false[\s\S]*holidayInput\.checked = false[\s\S]*openScheduleInput\.checked = false/)
  assert.match(client, /leaveInput\.checked = schedule\.is_leave === true/)
  assert.match(client, /\.rpc\('workforce_admin_save_leave_schedule'/)
  assert.match(client, /repeatWeeklyInput\.disabled = isOpenSchedule \|\| isLeave/)
})

test('Leave renders consistently in schedule management, My Schedule, and Home', async () => {
  const [management, personal, home, managementStyles, personalStyles, homeStyles] = await Promise.all([
    read('scripts/workforce-schedules.js'),
    read('scripts/my-schedule-v2.js'),
    read('scripts/home-workforce-calendar.js'),
    read('styles/workforce-admin.css'),
    read('styles/my-schedule.css'),
    read('styles/home-workforce-calendar.css')
  ])

  assert.match(management, /schedule\.is_leave \? 'leave'/)
  assert.match(personal, /if \(schedule\.is_leave\) return 'Leave'/)
  assert.match(personal, /button\.classList\.add\('leave'\)/)
  assert.match(home, /return \{ label: 'Leave', className: 'leave' \}/)
  assert.match(home, /button\.classList\.add\('work-leave'\)/)
  assert.match(managementStyles, /\.wf-schedule-chip\.leave/)
  assert.match(personalStyles, /\.schedule-entry\.leave/)
  assert.match(homeStyles, /\.calendar-day\.work-leave/)
  assert.match(homeStyles, /\.event-type\.leave/)
})

test('Leave is first-class database state and cannot create attendance', async () => {
  const [migration, attendance, teamAttendance] = await Promise.all([
    read('supabase/migrations/20260804131343_add_leave_schedule_type.sql'),
    read('scripts/attendance.js'),
    read('scripts/team-attendance.js')
  ])

  assert.match(migration, /add column if not exists is_leave boolean not null default false/)
  assert.match(migration, /is_leave[\s\S]*not is_rest_day[\s\S]*not is_holiday[\s\S]*shift_start is null[\s\S]*shift_end is null/)
  assert.match(migration, /function public\.workforce_admin_save_leave_schedule/)
  assert.match(migration, /A schedule with attendance cannot be changed to leave/)
  assert.match(migration, /function public\.workforce_reject_attended_leave_schedule/)
  assert.match(migration, /work_schedules_reject_attended_leave/)
  assert.match(migration, /Attendance cannot be recorded for a leave schedule/)
  assert.match(migration, /from public, anon[\s\S]*to authenticated, service_role/)
  assert.match(attendance, /visibleSchedules = \(scheduleResult\.data \|\| \[\]\)\.filter\(schedule => !schedule\.is_leave\)/)
  assert.equal((teamAttendance.match(/\.eq\('is_leave', false\)/g) || []).length, 2)
})
