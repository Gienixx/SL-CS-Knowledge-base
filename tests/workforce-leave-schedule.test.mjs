import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('create and edit schedule use three dropdowns for special schedules and classifications', async () => {
  const [html, client] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-schedules.js')
  ])

  assert.match(html, /id="scheduleOtherType"[\s\S]*value="rest_day">Rest day[\s\S]*value="holiday">Holiday[\s\S]*value="leave">Leave[\s\S]*value="absent">Absent/)
  assert.match(html, /id="scheduleLeaveType"[\s\S]*value="incentive_vl">Incentive VL[\s\S]*value="birthday_vl">Birthday VL[\s\S]*value="leave_without_pay">Leave Without Pay/)
  assert.match(html, /id="scheduleAbsenceType"[\s\S]*value="with_notification">ABSENT with Notif[\s\S]*value="without_notification">Absent without Notif/)
  assert.doesNotMatch(html, /id="scheduleIsRestDay"|id="scheduleIsHoliday"|id="scheduleIsLeave"/)
  assert.doesNotMatch(html, /not yet linked to a leave request|Leave-request linking will be added later/)
  assert.match(client, /const otherTypeSelect = document\.getElementById\('scheduleOtherType'\)/)
  assert.match(client, /leaveTypeField\.hidden = !isLeave[\s\S]*absenceTypeField\.hidden = !isAbsent/)
  assert.match(client, /const hasNoFixedTimes = isRestDay \|\| isLeave \|\| isAbsent \|\| isOpenSchedule/)
  assert.match(client, /otherTypeSelect\.value = schedule\.is_absent[\s\S]*schedule\.is_leave[\s\S]*schedule\.is_rest_day[\s\S]*schedule\.is_holiday/)
  assert.match(client, /\.rpc\('workforce_admin_save_nonworking_schedule'/)
  assert.match(client, /repeatWeeklyInput\.disabled = isOpenSchedule \|\| isLeave \|\| isAbsent/)
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

  assert.match(management, /schedule\.is_absent \? 'absent'/)
  assert.match(personal, /ABSENCE_TYPE_LABELS/)
  assert.match(personal, /button\.classList\.add\('leave'\)/)
  assert.match(personal, /button\.classList\.add\('absent'\)/)
  assert.match(home, /return \{ label: 'Leave', className: 'leave' \}/)
  assert.match(home, /return \{ label: 'Absent', className: 'absent' \}/)
  assert.match(home, /button\.classList\.add\('work-leave'\)/)
  assert.match(home, /button\.classList\.add\('work-absent'\)/)
  assert.match(managementStyles, /\.wf-schedule-chip\.leave/)
  assert.match(managementStyles, /\.wf-schedule-chip\.absent/)
  assert.match(personalStyles, /\.schedule-entry\.leave/)
  assert.match(personalStyles, /\.schedule-entry\.absent/)
  assert.match(homeStyles, /\.calendar-day\.work-leave/)
  assert.match(homeStyles, /\.calendar-day\.work-absent/)
  assert.match(homeStyles, /\.event-type\.leave/)
  assert.match(homeStyles, /\.event-type\.absent/)
})

test('Leave is first-class database state and cannot create attendance', async () => {
  const [migration, categoryMigration, attendance, teamAttendance] = await Promise.all([
    read('supabase/migrations/20260804131343_add_leave_schedule_type.sql'),
    read('supabase/migrations/20260804142306_add_schedule_leave_and_absence_categories.sql'),
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
  assert.match(categoryMigration, /add column if not exists is_absent boolean not null default false/)
  assert.match(categoryMigration, /leave_type text[\s\S]*absence_type text/)
  assert.match(categoryMigration, /function public\.workforce_admin_save_nonworking_schedule/)
  assert.match(categoryMigration, /incentive_vl[\s\S]*birthday_vl[\s\S]*leave_without_pay/)
  assert.match(categoryMigration, /with_notification[\s\S]*without_notification/)
  assert.match(categoryMigration, /Attendance cannot be recorded for an absent schedule/)
  assert.match(attendance, /visibleSchedules = \(scheduleResult\.data \|\| \[\]\)\.filter\(schedule => !schedule\.is_leave && !schedule\.is_absent\)/)
  assert.equal((teamAttendance.match(/\.eq\('is_leave', false\)/g) || []).length, 2)
  assert.equal((teamAttendance.match(/\.eq\('is_absent', false\)/g) || []).length, 2)
})
