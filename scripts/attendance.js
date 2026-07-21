import { supabase } from './supabaseClient.js?v=10'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const RELEASED_SCHEDULE_STATUSES = Object.freeze(['published', 'changed'])
const REQUEST_TIMEOUT_MS = 15000
const ATTENDANCE_STATUS_LABELS = Object.freeze({
  present: 'Present',
  absent: 'Absent',
  on_leave: 'On leave',
  excused: 'Excused'
})

const elements = {
  liveClock: document.getElementById('attendanceLiveClock'),
  timeZone: document.getElementById('attendanceTimeZone'),
  todayTitle: document.getElementById('attendanceTodayTitle'),
  todayBadge: document.getElementById('attendanceTodayBadge'),
  todayDate: document.getElementById('attendanceTodayDate'),
  todayShift: document.getElementById('attendanceTodayShift'),
  todayClockIn: document.getElementById('attendanceTodayClockIn'),
  todayClockOut: document.getElementById('attendanceTodayClockOut'),
  todayWorked: document.getElementById('attendanceTodayWorked'),
  todayStatus: document.getElementById('attendanceTodayStatus'),
  scheduleChooser: document.getElementById('attendanceScheduleChooser'),
  scheduleSelect: document.getElementById('attendanceScheduleSelect'),
  scheduleHelp: document.getElementById('attendanceScheduleHelp'),
  scheduleNotice: document.getElementById('attendanceScheduleNotice'),
  clockInButton: document.getElementById('attendanceClockInButton'),
  clockOutButton: document.getElementById('attendanceClockOutButton'),
  refreshButton: document.getElementById('attendanceRefreshButton'),
  actionMessage: document.getElementById('attendanceActionMessage'),
  historyMonth: document.getElementById('attendanceHistoryMonth'),
  historyStatus: document.getElementById('attendanceHistoryStatus'),
  historyBody: document.getElementById('attendanceHistoryBody'),
  historyMessage: document.getElementById('attendanceHistoryMessage')
}

let access = null
let profileIds = []
let visibleSchedules = []
let recentAttendance = []
let historyRows = []
let busy = false
let clockTimer = null

function errorMessage(error) {
  if (/abort|timeout/i.test(`${error?.name || ''} ${error?.message || ''}`)) {
    return 'The attendance request timed out. Check your connection and try again.'
  }
  return error?.message || 'An unexpected error occurred.'
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

function setActionMessage(text, type = '') {
  elements.actionMessage.textContent = text
  elements.actionMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setHistoryMessage(text, type = '') {
  elements.historyMessage.textContent = text
  elements.historyMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function offsetDateKey(value, days) {
  const date = parseDateKey(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: access?.timezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function monthRange(value) {
  const match = /^\d{4}-\d{2}$/.test(value) ? value : localDateKey().slice(0, 7)
  const start = `${match}-01`
  const endDate = parseDateKey(start)
  endDate.setUTCMonth(endDate.getUTCMonth() + 1, 0)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

function formatDate(value, includeWeekday = true) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(includeWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parseDateKey(value))
}

function formatTime(value, timezone = access?.timezone || 'America/New_York') {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}

function isSpecialDay(schedule) {
  return Boolean(schedule?.is_rest_day || schedule?.is_holiday)
}

function specialDayType(schedule) {
  if (schedule?.is_rest_day) return 'rest_day'
  if (schedule?.is_holiday) return 'holiday'
  return null
}

function specialDayLabel(schedule) {
  if (schedule?.is_rest_day) {
    return schedule.is_holiday && schedule.holiday_name
      ? `Rest day · ${schedule.holiday_name}`
      : 'Rest day'
  }

  if (schedule?.is_holiday) {
    return schedule.holiday_name ? `Holiday · ${schedule.holiday_name}` : 'Holiday'
  }

  return ''
}

function formatShift(schedule) {
  if (!schedule) return 'No assigned shift'

  if (schedule.is_rest_day && (!schedule.shift_start || !schedule.shift_end)) {
    return specialDayLabel(schedule)
  }

  if (!schedule.shift_start || !schedule.shift_end) {
    return schedule.is_holiday ? specialDayLabel(schedule) : 'Shift time unavailable'
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })
  const shiftTime = `${formatter.format(new Date(schedule.shift_start))} – ${formatter.format(new Date(schedule.shift_end))}`
  const specialLabel = specialDayLabel(schedule)
  return specialLabel ? `${shiftTime} · ${specialLabel}` : shiftTime
}

function scheduleById(scheduleId) {
  return visibleSchedules.find(schedule => schedule.id === scheduleId) || null
}

function selectedSchedule() {
  return scheduleById(elements.scheduleSelect.value)
}

function scheduleForAttendance(record) {
  if (!record?.schedule_id) return null
  return record.work_schedules || scheduleById(record.schedule_id)
}

function scheduleAvailability(schedule, now = new Date()) {
  if (!schedule) return { state: 'unavailable', startsAt: null, endsAt: null }

  if (isSpecialDay(schedule)) {
    const today = localDateKey(now)
    const yesterday = offsetDateKey(today, -1)
    const endsAt = schedule.shift_end ? new Date(schedule.shift_end) : null

    if (schedule.shift_date === today) {
      return { state: 'special', startsAt: null, endsAt }
    }

    if (
      schedule.shift_date === yesterday &&
      endsAt &&
      now.getTime() < endsAt.getTime()
    ) {
      return { state: 'active', startsAt: schedule.shift_start ? new Date(schedule.shift_start) : null, endsAt }
    }

    return { state: schedule.shift_date < today ? 'ended' : 'future', startsAt: null, endsAt }
  }

  if (!schedule.shift_start || !schedule.shift_end) {
    return { state: 'unavailable', startsAt: null, endsAt: null }
  }

  const startsAt = new Date(schedule.shift_start)
  const endsAt = new Date(schedule.shift_end)
  const nowMs = now.getTime()

  if (nowMs >= endsAt.getTime()) return { state: 'ended', startsAt, endsAt }
  if (nowMs < startsAt.getTime()) return { state: 'early', startsAt, endsAt }
  return { state: 'active', startsAt, endsAt }
}

function minutesBetween(start, end = new Date()) {
  if (!start) return 0
  const startTime = new Date(start).getTime()
  const endTime = end instanceof Date ? end.getTime() : new Date(end).getTime()
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return 0
  return Math.floor((endTime - startTime) / 60000)
}

function formatMinutes(totalMinutes) {
  const safeMinutes = Math.max(0, Number(totalMinutes) || 0)
  const hours = Math.floor(safeMinutes / 60)
  const minutes = safeMinutes % 60
  if (!hours) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

function workedMinutes(record, now = new Date()) {
  if (!record?.clock_in) return 0
  if (record.clock_out && Number.isFinite(Number(record.total_worked_minutes))) {
    return Math.max(0, Number(record.total_worked_minutes) || 0)
  }
  return minutesBetween(record.clock_in, record.clock_out || now)
}

function openAttendanceRecord() {
  return recentAttendance.find(record => record.clock_in && !record.clock_out) || null
}

function attendanceForSelectedSchedule() {
  const scheduleId = elements.scheduleSelect.value
  if (!scheduleId) {
    return recentAttendance.find(record => !record.schedule_id && record.work_date === localDateKey()) || null
  }
  return recentAttendance.find(record => record.schedule_id === scheduleId) || null
}

function currentAttendanceRecord() {
  return openAttendanceRecord() || attendanceForSelectedSchedule() || recentAttendance
    .slice()
    .sort((a, b) => new Date(b.clock_in || b.created_at) - new Date(a.clock_in || a.created_at))[0] || null
}

function badgeClass(status) {
  if (status === 'present') return 'success'
  if (status === 'absent') return 'danger'
  if (status === 'on_leave' || status === 'excused') return 'warning'
  return 'muted'
}

function setBadge(element, text, modifier = 'muted') {
  element.textContent = text
  element.className = `wf-badge ${modifier}`
}

function scheduleOptionLabel(schedule) {
  const dateLabel = schedule.shift_date === localDateKey() ? '' : `${formatDate(schedule.shift_date, false)} · `
  const statusLabel = schedule.status === 'changed' ? ' · Changed' : ''
  const overtimeLabel = schedule.is_rest_day
    ? ' · RDOT'
    : schedule.is_holiday
      ? ' · OT'
      : ''
  return `${dateLabel}${formatShift(schedule)}${overtimeLabel}${statusLabel}`
}

function renderScheduleChooser() {
  const previous = elements.scheduleSelect.value
  const now = new Date()
  const selectableSchedules = visibleSchedules
    .filter(schedule => {
      const availability = scheduleAvailability(schedule, now)
      return availability.state !== 'ended' || recentAttendance.some(record => record.schedule_id === schedule.id)
    })
    .sort((left, right) => {
      const leftTime = left.shift_start ? new Date(left.shift_start).getTime() : parseDateKey(left.shift_date).getTime()
      const rightTime = right.shift_start ? new Date(right.shift_start).getTime() : parseDateKey(right.shift_date).getTime()
      return leftTime - rightTime
    })

  elements.scheduleSelect.replaceChildren()

  if (selectableSchedules.length) {
    selectableSchedules.forEach(schedule => {
      elements.scheduleSelect.appendChild(new Option(scheduleOptionLabel(schedule), schedule.id))
    })

    const optionValues = [...elements.scheduleSelect.options].map(option => option.value)
    const availableSchedule = selectableSchedules.find(schedule =>
      ['early', 'active'].includes(scheduleAvailability(schedule, now).state) ||
      scheduleAvailability(schedule, now).state === 'special'
    )
    const preferred = optionValues.includes(previous)
      ? previous
      : availableSchedule?.id || selectableSchedules[0].id

    elements.scheduleSelect.value = preferred
    elements.scheduleChooser.hidden = false
  } else {
    elements.scheduleSelect.appendChild(new Option('No linked schedule', ''))
    elements.scheduleChooser.hidden = false
  }
}

function renderScheduleNotice() {
  const selected = selectedSchedule()
  const changedSchedules = visibleSchedules.filter(schedule => schedule.status === 'changed')

  elements.scheduleNotice.hidden = true
  elements.scheduleNotice.className = 'attendance-notice'
  elements.scheduleNotice.textContent = ''

  if (selected?.is_rest_day) {
    elements.scheduleNotice.textContent = selected.is_holiday
      ? 'This date is both a rest day and a holiday. All credited work is classified as RDOT so minutes are not counted twice.'
      : 'This is a rest day. You may clock in, and all credited work will be classified as RDOT.'
    elements.scheduleNotice.hidden = false
    return
  }

  if (selected?.is_holiday) {
    elements.scheduleNotice.textContent = selected.holiday_name
      ? `${selected.holiday_name}: you may clock in, and all credited work will count as overtime.`
      : 'This is a holiday. You may clock in, and all credited work will count as overtime.'
    elements.scheduleNotice.hidden = false
    return
  }

  if (changedSchedules.length) {
    elements.scheduleNotice.textContent = 'A visible schedule was changed after publication. Review the selected shift before clocking in.'
    elements.scheduleNotice.hidden = false
  }
}

function updateScheduleHelp() {
  const schedule = selectedSchedule()
  const record = attendanceForSelectedSchedule()

  if (!schedule) {
    elements.scheduleHelp.textContent = 'No released shift is currently available. You may clock in, and all credited worked minutes will count as RDOT.'
    return
  }

  if (record?.clock_in && record.clock_out) {
    elements.scheduleHelp.textContent = 'Attendance for this shift or work date has already been completed.'
    return
  }

  const availability = scheduleAvailability(schedule)
  if (availability.state === 'special') {
    elements.scheduleHelp.textContent = schedule.is_rest_day
      ? 'Clock-in is available for this rest day. All credited worked minutes count as RDOT, subject to the 20-hour work-date limit.'
      : 'Clock-in is available for this holiday. All credited worked minutes count as overtime, subject to the 20-hour work-date limit.'
  } else if (availability.state === 'early') {
    elements.scheduleHelp.textContent = 'Clock-in is available. Minutes before the scheduled start count as pre-shift overtime, subject to the 20-hour work-date limit.'
  } else if (availability.state === 'active') {
    elements.scheduleHelp.textContent = isSpecialDay(schedule)
      ? 'This special-day schedule is still active. Credited work remains overtime.'
      : 'This shift is currently active. You can clock in now.'
  } else if (availability.state === 'ended') {
    elements.scheduleHelp.textContent = 'This shift or work date has ended and is no longer available for clock-in.'
  } else if (availability.state === 'future') {
    elements.scheduleHelp.textContent = 'Rest-day and holiday clock-in opens on the scheduled work date.'
  } else {
    elements.scheduleHelp.textContent = 'Clock-in is unavailable for this schedule.'
  }
}

function updateActionState() {
  const openRecord = openAttendanceRecord()
  const schedule = selectedSchedule()
  const selectedRecord = attendanceForSelectedSchedule()
  const availability = schedule ? scheduleAvailability(schedule) : null
  const scheduleClockInOpen = schedule
    ? ['special', 'early', 'active'].includes(availability.state)
    : true
  const selectedCompleted = Boolean(selectedRecord?.clock_in && selectedRecord.clock_out)

  elements.clockInButton.disabled = busy || Boolean(openRecord) || selectedCompleted || !scheduleClockInOpen
  elements.clockOutButton.disabled = busy || !openRecord
  elements.scheduleSelect.disabled = busy || Boolean(openRecord)
  updateScheduleHelp()
}

function renderToday() {
  renderScheduleChooser()

  const record = currentAttendanceRecord()
  const recordSchedule = scheduleForAttendance(record)
  const fallbackSchedule = selectedSchedule() || null
  const displaySchedule = recordSchedule || fallbackSchedule
  const displayDate = record?.work_date || displaySchedule?.shift_date || localDateKey()

  elements.todayDate.textContent = formatDate(displayDate)
  elements.todayShift.textContent = formatShift(displaySchedule)
  elements.todayClockIn.textContent = formatTime(record?.clock_in)
  elements.todayClockOut.textContent = formatTime(record?.clock_out)
  elements.todayWorked.textContent = record?.clock_in ? formatMinutes(workedMinutes(record)) : '—'
  elements.todayStatus.textContent = record
    ? ATTENDANCE_STATUS_LABELS[record.attendance_status] || record.attendance_status
    : 'Not recorded'

  if (!record) {
    elements.todayTitle.textContent = 'Ready to start your shift'
    setBadge(elements.todayBadge, 'Not clocked in', 'muted')
  } else if (record.clock_in && !record.clock_out) {
    elements.todayTitle.textContent = 'Shift in progress'
    setBadge(elements.todayBadge, specialDayType(recordSchedule) === 'rest_day' ? 'RDOT in progress' : 'Clocked in', 'success')
  } else if (record.clock_in && record.clock_out) {
    elements.todayTitle.textContent = 'Attendance completed'
    setBadge(elements.todayBadge, 'Clocked out', 'success')
  } else {
    elements.todayTitle.textContent = ATTENDANCE_STATUS_LABELS[record.attendance_status] || 'Attendance recorded'
    setBadge(elements.todayBadge, ATTENDANCE_STATUS_LABELS[record.attendance_status] || record.attendance_status, badgeClass(record.attendance_status))
  }

  renderScheduleNotice()
  updateActionState()
}

function updateLiveClock() {
  const now = new Date()
  elements.liveClock.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(now)

  const record = openAttendanceRecord()
  if (record) elements.todayWorked.textContent = formatMinutes(workedMinutes(record, now))
  updateActionState()
}

function createTextCell(primary, secondary = '') {
  const cell = document.createElement('td')
  const main = document.createElement('span')
  main.className = 'wf-person'
  main.textContent = primary || '—'
  cell.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'wf-subtext'
    sub.textContent = secondary
    cell.appendChild(sub)
  }
  return cell
}

function createStatusCell(record) {
  const cell = document.createElement('td')
  const line = document.createElement('div')
  line.className = 'attendance-status-line'
  const status = document.createElement('span')
  status.className = `wf-badge ${badgeClass(record.attendance_status)}`
  status.textContent = ATTENDANCE_STATUS_LABELS[record.attendance_status] || record.attendance_status
  line.appendChild(status)

  if (record.is_late) {
    const late = document.createElement('span')
    late.className = 'wf-badge warning'
    late.textContent = 'Late'
    line.appendChild(late)
  }

  cell.appendChild(line)
  return cell
}

function createAdjustmentsCell(record) {
  const cell = document.createElement('td')
  const wrap = document.createElement('div')
  wrap.className = 'attendance-adjustments'
  const restDayOvertime = Math.max(0, Number(record.rest_day_overtime_minutes) || 0)
  const totalOvertime = Math.max(0, Number(record.total_overtime_minutes ?? record.overtime_minutes) || 0)
  const normalOvertime = Math.max(0, totalOvertime - restDayOvertime)
  const adjustments = [
    ['Late', record.minutes_late],
    ['RDOT', restDayOvertime],
    ['OT', normalOvertime],
    ['UT', record.undertime_minutes]
  ].filter(([, minutes]) => Number(minutes) > 0)

  if (!adjustments.length) {
    cell.textContent = '—'
    return cell
  }

  adjustments.forEach(([label, minutes]) => {
    const item = document.createElement('span')
    item.className = 'wf-badge warning'
    item.textContent = `${label} ${formatMinutes(minutes)}`
    wrap.appendChild(item)
  })
  cell.appendChild(wrap)
  return cell
}

function renderHistory() {
  const selectedStatus = elements.historyStatus.value
  const rows = historyRows.filter(record => !selectedStatus || record.attendance_status === selectedStatus)
  elements.historyBody.replaceChildren()

  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 8
    cell.className = 'wf-empty'
    cell.textContent = 'No attendance records match the selected month and status.'
    row.appendChild(cell)
    elements.historyBody.appendChild(row)
  } else {
    rows.forEach(record => {
      const row = document.createElement('tr')
      const schedule = record.work_schedules || null
      const scheduleNote = schedule?.is_rest_day
        ? 'Rest-day overtime'
        : schedule?.is_holiday
          ? 'Holiday overtime'
          : schedule?.status === 'changed'
            ? 'Changed schedule'
            : ''
      const notes = [record.admin_notes, record.correction_reason].filter(Boolean).join(' · ')
      const noteCell = document.createElement('td')
      noteCell.className = 'attendance-note-cell'
      noteCell.textContent = notes || '—'

      row.append(
        createTextCell(formatDate(record.work_date), record.corrected_at ? 'Corrected by an administrator' : ''),
        createTextCell(formatShift(schedule), scheduleNote),
        createTextCell(formatTime(record.clock_in)),
        createTextCell(formatTime(record.clock_out)),
        createTextCell(record.clock_in ? formatMinutes(workedMinutes(record)) : '—'),
        createStatusCell(record),
        createAdjustmentsCell(record),
        noteCell
      )
      elements.historyBody.appendChild(row)
    })
  }

  const presentRows = historyRows.filter(record => record.attendance_status === 'present')
  const workedTotal = historyRows.reduce((sum, record) => sum + workedMinutes(record), 0)
  document.getElementById('attendanceMonthCount').textContent = historyRows.length
  document.getElementById('attendancePresentCount').textContent = presentRows.length
  document.getElementById('attendanceLateCount').textContent = historyRows.filter(record => record.is_late).length
  document.getElementById('attendanceWorkedTotal').textContent = formatMinutes(workedTotal)
}

async function loadToday() {
  const today = localDateKey()
  const rangeStart = offsetDateKey(today, -1)
  const rangeEnd = offsetDateKey(today, 1)

  const scheduleQuery = supabase
    .from('work_schedules')
    .select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes')
    .in('user_id', profileIds)
    .gte('shift_date', rangeStart)
    .lte('shift_date', rangeEnd)
    .in('status', RELEASED_SCHEDULE_STATUSES)
    .order('shift_date')
    .order('shift_sequence')
    .abortSignal(requestSignal())

  const attendanceQuery = supabase
    .from('attendance')
    .select('id, user_id, schedule_id, work_date, clock_in, clock_out, attendance_status, is_late, minutes_late, overtime_minutes, pre_shift_overtime_minutes, regular_minutes, post_shift_overtime_minutes, rest_day_overtime_minutes, holiday_overtime_minutes, total_overtime_minutes, total_worked_minutes, undertime_minutes, correction_reason, admin_notes, corrected_at, created_at, updated_at, work_schedules(id, shift_date, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name)')
    .in('user_id', profileIds)
    .gte('work_date', rangeStart)
    .lte('work_date', rangeEnd)
    .order('created_at')
    .abortSignal(requestSignal())

  const [scheduleResult, attendanceResult] = await Promise.all([scheduleQuery, attendanceQuery])
  if (scheduleResult.error) throw scheduleResult.error
  if (attendanceResult.error) throw attendanceResult.error

  visibleSchedules = scheduleResult.data || []
  recentAttendance = attendanceResult.data || []
  renderToday()
}

async function loadHistory() {
  const range = monthRange(elements.historyMonth.value)
  setHistoryMessage('Loading attendance history...')

  const { data, error } = await supabase
    .from('attendance')
    .select('id, user_id, schedule_id, work_date, clock_in, clock_out, attendance_status, is_late, minutes_late, overtime_minutes, pre_shift_overtime_minutes, regular_minutes, post_shift_overtime_minutes, rest_day_overtime_minutes, holiday_overtime_minutes, total_overtime_minutes, total_worked_minutes, undertime_minutes, correction_reason, admin_notes, corrected_at, created_at, updated_at, work_schedules(id, shift_date, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name)')
    .in('user_id', profileIds)
    .gte('work_date', range.start)
    .lte('work_date', range.end)
    .order('work_date', { ascending: false })
    .order('created_at', { ascending: false })
    .abortSignal(requestSignal())

  if (error) throw error
  historyRows = data || []
  renderHistory()
  setHistoryMessage(`${historyRows.length} attendance record${historyRows.length === 1 ? '' : 's'} loaded.`)
}

function setBusy(value, label = '') {
  busy = value
  elements.refreshButton.disabled = value
  elements.clockInButton.textContent = value && label === 'clock-in' ? 'Clocking in...' : 'Clock In'
  elements.clockOutButton.textContent = value && label === 'clock-out' ? 'Clocking out...' : 'Clock Out'
  updateActionState()
}

async function refreshAll({ silent = false } = {}) {
  if (busy) return
  setBusy(true)
  if (!silent) setActionMessage('Refreshing attendance...')

  try {
    await Promise.all([loadToday(), loadHistory()])
    if (!silent) setActionMessage('Attendance is up to date.', 'success')
  } catch (error) {
    setActionMessage(errorMessage(error), 'error')
    setHistoryMessage(errorMessage(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function clockIn() {
  if (busy || elements.clockInButton.disabled) return
  const scheduleId = elements.scheduleSelect.value || null
  const schedule = selectedSchedule()
  setBusy(true, 'clock-in')
  setActionMessage(
    schedule?.is_rest_day
      ? 'Recording your rest-day overtime clock-in...'
      : schedule?.is_holiday
        ? 'Recording your holiday overtime clock-in...'
        : schedule
          ? 'Recording your clock-in...'
          : 'Recording your RDOT clock-in...'
  )

  try {
    const { error } = await supabase
      .rpc('workforce_clock_in', { p_schedule_id: scheduleId })
      .abortSignal(requestSignal())
    if (error) throw error
    await Promise.all([loadToday(), loadHistory()])
    setActionMessage(
      schedule?.is_rest_day
        ? 'Rest-day overtime clock-in recorded successfully.'
        : schedule?.is_holiday
          ? 'Holiday overtime clock-in recorded successfully.'
          : schedule
            ? 'Clock-in recorded successfully.'
            : 'RDOT clock-in recorded successfully.',
      'success'
    )
  } catch (error) {
    setActionMessage(errorMessage(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function clockOut() {
  if (busy || elements.clockOutButton.disabled) return
  setBusy(true, 'clock-out')
  setActionMessage('Recording your clock-out...')

  try {
    const { error } = await supabase
      .rpc('workforce_clock_out')
      .abortSignal(requestSignal())
    if (error) throw error
    await Promise.all([loadToday(), loadHistory()])
    setActionMessage('Clock-out recorded successfully.', 'success')
  } catch (error) {
    setActionMessage(errorMessage(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./attendance.html')}`)
    return
  }

  if (!access.allowed || access.is_agent !== true) {
    window.alert('Attendance access is available only to active agent profiles.')
    window.location.replace('./home.html')
    return
  }

  profileIds = [...new Set([
    ...(Array.isArray(access.linked_profile_ids) ? access.linked_profile_ids : []),
    access.user_id
  ].filter(Boolean))]

  if (!profileIds.length) throw new Error('No workforce profile is linked to this account.')

  elements.timeZone.textContent = access.timezone || 'America/New_York'
  elements.historyMonth.value = localDateKey().slice(0, 7)

  const workforceLink = document.getElementById('attendanceWorkforceLink')
  workforceLink.hidden = !(access.is_admin === true && hasWorkforcePermission(access, 'manage_employees'))

  elements.clockInButton.addEventListener('click', clockIn)
  elements.clockOutButton.addEventListener('click', clockOut)
  elements.refreshButton.addEventListener('click', () => refreshAll())
  elements.scheduleSelect.addEventListener('change', renderToday)
  elements.historyMonth.addEventListener('change', async () => {
    try {
      await loadHistory()
    } catch (error) {
      setHistoryMessage(errorMessage(error), 'error')
    }
  })
  elements.historyStatus.addEventListener('change', renderHistory)

  updateLiveClock()
  clockTimer = window.setInterval(updateLiveClock, 1000)
  window.addEventListener('pagehide', () => {
    if (clockTimer) window.clearInterval(clockTimer)
  }, { once: true })

  await refreshAll({ silent: true })
  setActionMessage('Attendance is ready.')
}

initialize().catch(error => {
  console.error('Attendance initialization failed:', error)
  setActionMessage(errorMessage(error), 'error')
  setHistoryMessage(errorMessage(error), 'error')
})
