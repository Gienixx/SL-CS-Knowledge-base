import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const RELEASED_SCHEDULE_STATUSES = Object.freeze(['published', 'changed'])
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
let todaySchedules = []
let todayAttendance = []
let historyRows = []
let busy = false
let clockTimer = null

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setActionMessage(text, type = '') {
  elements.actionMessage.textContent = text
  elements.actionMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setHistoryMessage(text, type = '') {
  elements.historyMessage.textContent = text
  elements.historyMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setBusy(value, label = '') {
  busy = value
  elements.refreshButton.disabled = value
  elements.clockInButton.textContent = value && label === 'clock-in' ? 'Clocking in...' : 'Clock In'
  elements.clockOutButton.textContent = value && label === 'clock-out' ? 'Clocking out...' : 'Clock Out'
  updateActionState()
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

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
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

function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: access?.timezone || 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))
}

function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}

function formatShift(schedule) {
  if (!schedule) return 'No assigned shift'
  if (schedule.is_rest_day) return 'Rest day'
  if (!schedule.shift_start || !schedule.shift_end) return 'Shift time unavailable'

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${formatter.format(new Date(schedule.shift_start))} – ${formatter.format(new Date(schedule.shift_end))}`
}

function scheduleById(scheduleId) {
  return todaySchedules.find(schedule => schedule.id === scheduleId) || null
}

function scheduleForAttendance(record) {
  if (!record?.schedule_id) return null
  return record.work_schedules || scheduleById(record.schedule_id)
}

function selectedSchedule() {
  return scheduleById(elements.scheduleSelect.value)
}

function currentAttendanceRecord() {
  const open = todayAttendance.find(record => record.clock_in && !record.clock_out)
  if (open) return open

  return todayAttendance
    .slice()
    .sort((a, b) => new Date(b.clock_in || b.created_at) - new Date(a.clock_in || a.created_at))[0] || null
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
  return minutesBetween(record.clock_in, record.clock_out || now)
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

function updateLiveClock() {
  const now = new Date()
  elements.liveClock.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(now)

  const record = currentAttendanceRecord()
  if (record?.clock_in && !record.clock_out) {
    elements.todayWorked.textContent = formatMinutes(workedMinutes(record, now))
  }
}

function renderScheduleChooser() {
  const previous = elements.scheduleSelect.value
  const workingSchedules = todaySchedules.filter(schedule => !schedule.is_rest_day)
  const restSchedules = todaySchedules.filter(schedule => schedule.is_rest_day)

  elements.scheduleSelect.replaceChildren()

  if (workingSchedules.length) {
    workingSchedules.forEach((schedule, index) => {
      const statusLabel = schedule.status === 'changed' ? ' · Changed' : ''
      elements.scheduleSelect.appendChild(new Option(
        `${formatShift(schedule)}${statusLabel}`,
        schedule.id,
        index === 0,
        index === 0
      ))
    })

    if ([...elements.scheduleSelect.options].some(option => option.value === previous)) {
      elements.scheduleSelect.value = previous
    }

    elements.scheduleChooser.hidden = false
    elements.scheduleHelp.textContent = workingSchedules.length > 1
      ? 'Select the shift you are starting before clocking in.'
      : 'Your attendance will be linked to this assigned shift.'
  } else if (restSchedules.length) {
    elements.scheduleChooser.hidden = true
    elements.scheduleHelp.textContent = ''
  } else {
    elements.scheduleSelect.appendChild(new Option('No linked schedule', ''))
    elements.scheduleChooser.hidden = false
    elements.scheduleHelp.textContent = 'No released shift is assigned today. Clock-in will be recorded as unscheduled attendance.'
  }
}

function renderScheduleNotice() {
  const changedSchedules = todaySchedules.filter(schedule => schedule.status === 'changed' && !schedule.is_rest_day)
  const restDay = todaySchedules.find(schedule => schedule.is_rest_day)

  elements.scheduleNotice.hidden = true
  elements.scheduleNotice.className = 'attendance-notice'
  elements.scheduleNotice.textContent = ''

  if (restDay && !todaySchedules.some(schedule => !schedule.is_rest_day)) {
    elements.scheduleNotice.textContent = restDay.is_holiday
      ? `Today is marked as a rest day${restDay.holiday_name ? ` for ${restDay.holiday_name}` : ' and holiday'}. Clock-in is disabled.`
      : 'Today is marked as a rest day. Clock-in is disabled.'
    elements.scheduleNotice.classList.add('danger')
    elements.scheduleNotice.hidden = false
    return
  }

  if (changedSchedules.length) {
    elements.scheduleNotice.textContent = 'Today’s schedule was changed after publication. Review the latest shift time before clocking in.'
    elements.scheduleNotice.hidden = false
  }
}

function updateActionState() {
  const record = currentAttendanceRecord()
  const hasOpenRecord = Boolean(record?.clock_in && !record.clock_out)
  const isCompleted = Boolean(record?.clock_in && record.clock_out)
  const onlyRestDay = todaySchedules.length > 0 && todaySchedules.every(schedule => schedule.is_rest_day)

  elements.clockInButton.disabled = busy || hasOpenRecord || isCompleted || onlyRestDay
  elements.clockOutButton.disabled = busy || !hasOpenRecord
  elements.scheduleSelect.disabled = busy || hasOpenRecord || isCompleted
}

function renderToday() {
  const today = localDateKey()
  const record = currentAttendanceRecord()
  const recordSchedule = scheduleForAttendance(record)
  const fallbackSchedule = selectedSchedule() || todaySchedules.find(schedule => !schedule.is_rest_day) || todaySchedules[0] || null
  const displaySchedule = recordSchedule || fallbackSchedule

  elements.todayDate.textContent = formatDate(today)
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
    setBadge(elements.todayBadge, 'Clocked in', 'success')
  } else if (record.clock_in && record.clock_out) {
    elements.todayTitle.textContent = 'Attendance completed'
    setBadge(elements.todayBadge, 'Clocked out', 'success')
  } else {
    elements.todayTitle.textContent = ATTENDANCE_STATUS_LABELS[record.attendance_status] || 'Attendance recorded'
    setBadge(elements.todayBadge, ATTENDANCE_STATUS_LABELS[record.attendance_status] || record.attendance_status, badgeClass(record.attendance_status))
  }

  renderScheduleChooser()
  renderScheduleNotice()
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
  const adjustments = [
    ['Late', record.minutes_late],
    ['OT', record.overtime_minutes],
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
      const notes = [record.admin_notes, record.correction_reason].filter(Boolean).join(' · ')
      const noteCell = document.createElement('td')
      noteCell.className = 'attendance-note-cell'
      noteCell.textContent = notes || '—'

      row.append(
        createTextCell(formatDate(record.work_date), record.corrected_at ? 'Corrected by an administrator' : ''),
        createTextCell(formatShift(schedule), schedule?.status === 'changed' ? 'Changed schedule' : ''),
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
  const scheduleQuery = supabase
    .from('work_schedules')
    .select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes')
    .in('user_id', profileIds)
    .eq('shift_date', today)
    .in('status', RELEASED_SCHEDULE_STATUSES)
    .order('shift_sequence')

  const attendanceQuery = supabase
    .from('attendance')
    .select('id, user_id, schedule_id, work_date, clock_in, clock_out, attendance_status, is_late, minutes_late, overtime_minutes, undertime_minutes, correction_reason, admin_notes, corrected_at, created_at, updated_at, work_schedules(id, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name)')
    .in('user_id', profileIds)
    .eq('work_date', today)
    .order('created_at')

  const [scheduleResult, attendanceResult] = await Promise.all([scheduleQuery, attendanceQuery])
  if (scheduleResult.error) throw scheduleResult.error
  if (attendanceResult.error) throw attendanceResult.error

  todaySchedules = scheduleResult.data || []
  todayAttendance = attendanceResult.data || []
  renderToday()
}

async function loadHistory() {
  const range = monthRange(elements.historyMonth.value)
  setHistoryMessage('Loading attendance history...')

  const { data, error } = await supabase
    .from('attendance')
    .select('id, user_id, schedule_id, work_date, clock_in, clock_out, attendance_status, is_late, minutes_late, overtime_minutes, undertime_minutes, correction_reason, admin_notes, corrected_at, created_at, updated_at, work_schedules(id, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name)')
    .in('user_id', profileIds)
    .gte('work_date', range.start)
    .lte('work_date', range.end)
    .order('work_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw error
  historyRows = data || []
  renderHistory()
  setHistoryMessage(`${historyRows.length} attendance record${historyRows.length === 1 ? '' : 's'} loaded.`)
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
  if (busy) return
  const scheduleId = elements.scheduleSelect.value || null
  setBusy(true, 'clock-in')
  setActionMessage('Recording your clock-in...')

  try {
    const { error } = await supabase.rpc('workforce_clock_in', {
      p_schedule_id: scheduleId
    })
    if (error) throw error

    await Promise.all([loadToday(), loadHistory()])
    setActionMessage('Clock-in recorded successfully.', 'success')
  } catch (error) {
    setActionMessage(errorMessage(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function clockOut() {
  if (busy) return
  setBusy(true, 'clock-out')
  setActionMessage('Recording your clock-out...')

  try {
    const { error } = await supabase.rpc('workforce_clock_out')
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

  if (!profileIds.length) {
    throw new Error('No workforce profile is linked to this account.')
  }

  elements.timeZone.textContent = access.timezone || 'America/New_York'
  elements.historyMonth.value = localDateKey().slice(0, 7)

  const workforceLink = document.getElementById('attendanceWorkforceLink')
  workforceLink.hidden = !(
    access.is_admin === true &&
    hasWorkforcePermission(access, 'manage_employees')
  )

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
