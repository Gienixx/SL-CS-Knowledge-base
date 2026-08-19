import { supabase } from './supabaseClient.js?v=11'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess,
  redactAttendanceCorrectionForViewer
} from './workforce-permissions.js?v=2'
import { formatScheduleOptionLabel } from '../shared/schedule-labels.js?v=1'

const RELEASED_SCHEDULE_STATUSES = Object.freeze(['published', 'changed'])
const SCHEDULE_PLACEHOLDER = '__SCHEDULE_PLACEHOLDER__'
const ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'
const WORK_ON_VL = '__WORK_ON_VL__'
const PAID_VL_TYPES = Object.freeze(['incentive_vl', 'birthday_vl'])
const REQUEST_TIMEOUT_MS = 15000
const HISTORY_PAGE_SIZE = 5
const OPEN_SESSION_LIMIT_MINUTES = 20 * 60
const ATTENDANCE_STATUS_LABELS = Object.freeze({
  present: 'Present',
  absent: 'Absent',
  on_leave: 'On leave',
  excused: 'Excused'
})
const CORRECTION_REASON_LABELS = Object.freeze({
  forgot_clock_in: 'Forgot to clock in',
  forgot_to_clock_in: 'Forgot to clock in',
  forgot_clock_out: 'Forgot to clock out',
  forgot_to_clock_out: 'Forgot to clock out',
  system_issue: 'System issue',
  connection_issue: 'Connection issue',
  incorrect_schedule: 'Incorrect schedule',
  approved_overtime: 'Approved overtime',
  manager_confirmed: 'Manager confirmed',
  other: 'Other'
})

const elements = {
  liveClock: document.getElementById('attendanceLiveClock'),
  liveClockValue: document.getElementById('attendanceLiveClockValue'),
  liveClockPeriod: document.getElementById('attendanceLiveClockPeriod'),
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
  adminAssistHistoricalClockIn: document.getElementById('attendanceAdminAssistHistoricalClockIn'),
  adminAssistClockInDate: document.getElementById('attendanceAdminAssistClockInDate'),
  adminAssistClockInTime: document.getElementById('attendanceAdminAssistClockInTime'),
  adminAssistClockInHelp: document.getElementById('attendanceAdminAssistClockInHelp'),
  scheduleHelp: document.getElementById('attendanceScheduleHelp'),
  scheduleNotice: document.getElementById('attendanceScheduleNotice'),
  clockInButton: document.getElementById('attendanceClockInButton'),
  clockOutButton: document.getElementById('attendanceClockOutButton'),
  refreshButton: document.getElementById('attendanceRefreshButton'),
  actionMessage: document.getElementById('attendanceActionMessage'),
  adminAssist: document.getElementById('attendanceAdminAssist'),
  adminAssistTitle: document.getElementById('attendanceAdminAssistTitle'),
  adminAssistTeam: document.getElementById('attendanceAdminAssistTeam'),
  adminAssistEnter: document.getElementById('attendanceAdminAssistEnter'),
  adminAssistExit: document.getElementById('attendanceAdminAssistExit'),
  adminAssistPrevious: document.getElementById('attendanceAdminAssistPrevious'),
  adminAssistNext: document.getElementById('attendanceAdminAssistNext'),
  prepaidBalance: document.getElementById('attendancePrepaidBalance'),
  prepaidBalanceBody: document.getElementById('attendancePrepaidBalanceBody'),
  historyMonth: document.getElementById('attendanceHistoryMonth'),
  historyPeriod: document.getElementById('attendanceHistoryPeriod'),
  historyStatus: document.getElementById('attendanceHistoryStatus'),
  historyBody: document.getElementById('attendanceHistoryBody'),
  historyMessage: document.getElementById('attendanceHistoryMessage'),
  historyPrevious: document.getElementById('attendanceHistoryPrevious'),
  historyNext: document.getElementById('attendanceHistoryNext'),
  historyPageStatus: document.getElementById('attendanceHistoryPageStatus')
}

let access = null
let profileIds = []
let visibleSchedules = []
let todaySchedules = []
let recentAttendance = []
let historyRows = []
let prepaidBalances = []
let historyPage = 1
let activeHistoryRange = null
let busy = false
let clockTimer = null
let activeLocalDate = ''
let localDateRefreshPending = false
let adminAssistAllowed = false
let adminAssistMode = false
let adminAssistEmployees = []
let adminAssistIndex = -1
let adminAssistTarget = null
let adminAssistSnapshot = null
let adminAssistOriginalAccess = null
let adminAssistOriginalProfileIds = []
let adminAssistHistoricalClockInScheduleId = ''
let overDurationFlaggedRecordId = ''
let overDurationFlagRetryAt = 0

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

function relativeScheduleDateLabel(workDate, now = new Date()) {
  if (!workDate) return ''
  const today = localDateKey(now)
  if (workDate === today) return 'Today'
  if (workDate === offsetDateKey(today, -1)) return 'Yesterday'
  if (workDate === offsetDateKey(today, 1)) return 'Tomorrow'
  return ''
}

function formatScheduleDateLabel(workDate, now = new Date()) {
  return [relativeScheduleDateLabel(workDate, now), formatDate(workDate, false)]
    .filter(Boolean)
    .join(' · ')
}

function monthRange(value) {
  const match = /^\d{4}-\d{2}$/.test(value) ? value : localDateKey().slice(0, 7)
  const start = `${match}-01`
  const endDate = parseDateKey(start)
  endDate.setUTCMonth(endDate.getUTCMonth() + 1, 0)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

function defaultHistoryPeriod(dateKey = localDateKey()) {
  return Number(String(dateKey).slice(-2)) <= 15 ? 'first' : 'second'
}

function historyRange(value, period = defaultHistoryPeriod()) {
  const month = monthRange(value)
  return period === 'second'
    ? { start: `${month.start.slice(0, 8)}16`, end: month.end }
    : { start: month.start, end: `${month.start.slice(0, 8)}15` }
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

function formatCorrectionReason(value) {
  const rawReason = String(value || '').trim().replace(/^reason\s*:\s*/i, '')
  if (!rawReason) return '—'

  const reasonCode = rawReason.split(/\s*(?::|·|\|)\s*/, 1)[0]
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (CORRECTION_REASON_LABELS[reasonCode]) return CORRECTION_REASON_LABELS[reasonCode]

  const readableReason = reasonCode.replace(/_+/g, ' ').trim()
  return readableReason
    ? `${readableReason.charAt(0).toUpperCase()}${readableReason.slice(1)}`
    : '—'
}

function isSpecialDay(schedule) {
  return Boolean(schedule?.is_rest_day || schedule?.is_holiday)
}

function isOpenSchedule(schedule) {
  return Boolean(
    schedule &&
    !isSpecialDay(schedule) &&
    !schedule.shift_start &&
    !schedule.shift_end
  )
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
    return schedule.is_holiday ? specialDayLabel(schedule) : 'Open schedule'
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

function isAdditionalWorkSessionSelected() {
  return elements.scheduleSelect.value === ADDITIONAL_WORK_SESSION
}

function isWorkOnVLSelected() {
  return elements.scheduleSelect.value === WORK_ON_VL
}

function isPaidVLSchedule(schedule) {
  return Boolean(schedule?.is_leave && PAID_VL_TYPES.includes(schedule.leave_type))
}

function paidLeaveWorkOptionEligible(now = new Date()) {
  if (adminAssistMode || openAttendanceRecord()) return false

  const workDate = localDateKey(now)
  const dateSchedules = todaySchedules.filter(schedule => schedule.shift_date === workDate)
  if (!dateSchedules.some(isPaidVLSchedule)) return false
  if (dateSchedules.some(schedule => schedule.is_absent)) return false
  if (dateSchedules.some(schedule =>
    !schedule.is_leave &&
    !schedule.is_absent &&
    (isSpecialDay(schedule) || (schedule.shift_start && schedule.shift_end))
  )) return false
  if (hasCompletedAttendanceForDate(workDate)) return false
  return true
}

function leaveScheduleOptionLabel(schedule, now = new Date()) {
  const leaveLabel = schedule.leave_type === 'incentive_vl'
    ? 'Incentive VL'
    : schedule.leave_type === 'birthday_vl'
      ? 'Birthday VL'
      : 'Unpaid leave'
  return `${formatScheduleDateLabel(schedule.shift_date, now)} · Sequence ${schedule.shift_sequence || 1} · ${leaveLabel} · Leave`
}

function scheduleForAttendance(record) {
  if (!record?.schedule_id) return null
  return record.work_schedules || scheduleById(record.schedule_id)
}

function hasCompletedAttendanceForDate(workDate) {
  return recentAttendance.some(record =>
    record.work_date === workDate &&
    Boolean(record.clock_in) &&
    Boolean(record.clock_out)
  )
}

function scheduleAvailability(schedule, now = new Date()) {
  if (!schedule) return { state: 'unavailable', startsAt: null, endsAt: null }

  if (isSpecialDay(schedule)) {
    const today = localDateKey(now)
    const yesterday = offsetDateKey(today, -1)
    const tomorrow = offsetDateKey(today, 1)
    const endsAt = schedule.shift_end ? new Date(schedule.shift_end) : null

    if (schedule.shift_date === today) {
      return { state: 'special', startsAt: null, endsAt }
    }

    if (
      schedule.shift_date === tomorrow &&
      hasCompletedAttendanceForDate(today)
    ) {
      return {
        state: 'next-day-special',
        startsAt: schedule.shift_start ? new Date(schedule.shift_start) : null,
        endsAt
      }
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

  if (isOpenSchedule(schedule)) {
    const today = localDateKey(now)
    if (schedule.shift_date === today) {
      return { state: 'open', startsAt: null, endsAt: null }
    }
    return {
      state: schedule.shift_date < today ? 'ended' : 'future',
      startsAt: null,
      endsAt: null
    }
  }

  if (!schedule.shift_start || !schedule.shift_end) {
    return { state: 'unavailable', startsAt: null, endsAt: null }
  }

  const startsAt = new Date(schedule.shift_start)
  const endsAt = new Date(schedule.shift_end)
  const nowMs = now.getTime()

  const tomorrow = offsetDateKey(localDateKey(now), 1)
  const isEarlyTomorrow = schedule.shift_date === tomorrow && startsAt.getHours() < 12

  if (isEarlyTomorrow && nowMs < startsAt.getTime()) {
    return { state: 'next-day-overnight', startsAt, endsAt }
  }

  if (nowMs >= endsAt.getTime()) return { state: 'ended', startsAt, endsAt }
  if (nowMs < startsAt.getTime()) return { state: 'early', startsAt, endsAt }
  return { state: 'active', startsAt, endsAt }
}

function isUntimedRestDayWithinClockInWindow(schedule, now = new Date()) {
  if (!schedule?.is_rest_day || schedule.shift_start || schedule.shift_end) return false

  const today = localDateKey(now)
  return [today, offsetDateKey(today, 1)].includes(schedule.shift_date)
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

function canUseAdminAssist() {
  return access?.is_admin === true &&
    hasWorkforcePermission(access, 'view_team_attendance') &&
    hasWorkforcePermission(access, 'correct_attendance')
}

function renderAdminAssistControls() {
  const active = adminAssistMode && adminAssistTarget
  elements.adminAssistEnter.hidden = !adminAssistAllowed || active
  elements.adminAssist.hidden = !active
  elements.adminAssistPrevious.hidden = !active
  elements.adminAssistNext.hidden = !active
  if (!active) return

  elements.adminAssistTitle.textContent = `Admin Assist · Viewing ${adminAssistTarget.full_name}`
  elements.adminAssistTeam.textContent = adminAssistTarget.team_name || 'Workforce employee'
  elements.adminAssistPrevious.disabled = adminAssistIndex <= 0
  elements.adminAssistNext.disabled = adminAssistIndex >= adminAssistEmployees.length - 1
}

async function loadAdminAssistEmployees() {
  const { data, error } = await supabase.rpc('workforce_admin_assist_list_employees')
  if (error) throw error
  adminAssistEmployees = data || []
}

function assistSnapshotRange() {
  const today = localDateKey()
  const history = historyRange(elements.historyMonth.value, elements.historyPeriod.value)
  return {
    start: history.start < offsetDateKey(today, -1) ? history.start : offsetDateKey(today, -1),
    end: history.end > offsetDateKey(today, 1) ? history.end : offsetDateKey(today, 1)
  }
}

async function loadAdminAssistSnapshot() {
  const range = assistSnapshotRange()
  const { data, error } = await supabase.rpc('workforce_admin_assist_snapshot', {
    p_target_user_id: adminAssistTarget.user_id,
    p_start_date: range.start,
    p_end_date: range.end
  })
  if (error) throw error

  adminAssistSnapshot = data || {}
  if (adminAssistTarget?.timezone) {
    elements.timeZone.textContent = adminAssistTarget.timezone
  }
  todaySchedules = adminAssistSnapshot.schedules || []
  visibleSchedules = todaySchedules.filter(schedule => !schedule.is_leave && !schedule.is_absent)
  recentAttendance = adminAssistSnapshot.attendance || []
  historyRows = (adminAssistSnapshot.history || []).map(record => ({
    ...record,
    work_schedules: record.schedule_id || record.schedule_start
      ? {
          id: record.schedule_id,
          shift_start: record.schedule_start,
          shift_end: record.schedule_end,
          timezone: record.schedule_timezone,
          status: record.schedule_status,
          is_rest_day: record.schedule_is_rest_day,
          is_holiday: record.schedule_is_holiday,
          holiday_name: record.holiday_name
        }
      : null
  }))
  prepaidBalances = adminAssistSnapshot.prepaid_balances || []
  renderToday()
  activeHistoryRange = historyRange(elements.historyMonth.value, elements.historyPeriod.value)
  historyPage = 1
  renderHistory()
  renderPrepaidBalances()
}

async function enterAdminAssist() {
  if (!adminAssistAllowed) return
  await loadAdminAssistEmployees()
  if (!adminAssistEmployees.length) throw new Error('No active employees are available for Admin Assist.')

  adminAssistOriginalAccess = access
  adminAssistOriginalProfileIds = [...profileIds]
  adminAssistIndex = Math.max(0, adminAssistEmployees.findIndex(employee => employee.user_id !== access.user_id))
  adminAssistTarget = adminAssistEmployees[adminAssistIndex]
  adminAssistMode = true
  access = { ...access, timezone: adminAssistTarget.timezone || access.timezone }
  profileIds = [adminAssistTarget.user_id]
  renderAdminAssistControls()
  await loadAdminAssistSnapshot()
  setActionMessage('Admin Assist is ready.')
}

async function exitAdminAssist() {
  adminAssistMode = false
  adminAssistTarget = null
  adminAssistSnapshot = null
  adminAssistIndex = -1
  access = adminAssistOriginalAccess || access
  profileIds = adminAssistOriginalProfileIds.length ? adminAssistOriginalProfileIds : [access.user_id]
  renderAdminAssistControls()
  await refreshAll()
}

async function selectAdminAssistEmployee(index) {
  if (!adminAssistMode || !adminAssistEmployees[index]) return
  adminAssistIndex = index
  adminAssistTarget = adminAssistEmployees[index]
  access = { ...adminAssistOriginalAccess, timezone: adminAssistTarget.timezone || adminAssistOriginalAccess.timezone }
  profileIds = [adminAssistTarget.user_id]
  renderAdminAssistControls()
  await loadAdminAssistSnapshot()
}

function assistReason(action) {
  const reason = window.prompt(`Reason for Admin Assist ${action}:`, 'Agent unable to use Attendance page')
  return typeof reason === 'string' && reason.trim().length >= 5 ? reason.trim() : null
}

function formatPrepaidTime(value, timezone = access?.timezone || 'America/New_York') {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function renderPrepaidBalances() {
  if (!prepaidBalances.length) {
    elements.prepaidBalance.hidden = true
    elements.prepaidBalanceBody.replaceChildren()
    return
  }

  const fragment = document.createDocumentFragment()
  prepaidBalances.forEach(balance => {
    const item = document.createElement('article')
    item.className = 'attendance-prepaid-balance-item'

    const heading = document.createElement('div')
    heading.className = 'attendance-prepaid-balance-heading'
    const date = document.createElement('strong')
    date.textContent = `${formatDate(balance.work_date, false)} · ${formatPrepaidTime(balance.prepaid_clock_in, balance.timezone)}–${formatPrepaidTime(balance.prepaid_clock_out, balance.timezone)}`
    heading.appendChild(date)

    const detail = document.createElement('p')
    detail.textContent = `Original: ${formatMinutes(balance.prepaid_minutes)} | Fulfilled: ${formatMinutes(balance.settled_minutes)} | Remaining: ${formatMinutes(balance.remaining_minutes)}`

    item.append(heading, detail)
    fragment.appendChild(item)
  })

  elements.prepaidBalanceBody.replaceChildren(fragment)
  elements.prepaidBalance.hidden = false
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

function maybePersistOverDurationFlag(record, now = new Date()) {
  if (!record?.id || record.manager_review_reason || minutesBetween(record.clock_in, now) <= OPEN_SESSION_LIMIT_MINUTES) return
  if (overDurationFlaggedRecordId === record.id && Date.now() < overDurationFlagRetryAt) return

  overDurationFlaggedRecordId = record.id
  overDurationFlagRetryAt = Number.POSITIVE_INFINITY
  void supabase.rpc('workforce_flag_current_open_attendance_over_duration')
    .then(({ data, error }) => {
      if (error) throw error
      record.manager_review_reason = data?.manager_review_reason || 'open_session_over_20_hours'
    })
    .catch(error => {
      overDurationFlagRetryAt = Date.now() + 60_000
      console.error('Unable to persist the over-duration attendance flag:', error)
    })
}

function canClockAdditionalSession() {
  const completedForWorkDate = hasCompletedAttendanceForDate(activeLocalDate)
  const hasUnusedEligibleSchedule = visibleSchedules.some(schedule => {
    if (schedule.shift_date !== activeLocalDate || schedule.is_leave || schedule.is_absent) return false
    const availability = scheduleAvailability(schedule)
    const unused = !recentAttendance.some(record => record.schedule_id === schedule.id && record.clock_in)
    return unused && ['next-day-special', 'next-day-overnight', 'special', 'early', 'active'].includes(availability.state)
  })

  return completedForWorkDate && !hasUnusedEligibleSchedule
}

function attendanceForSelectedSchedule() {
  const scheduleId = elements.scheduleSelect.value
  if (!scheduleId || scheduleId === ADDITIONAL_WORK_SESSION) {
    return recentAttendance.find(record => !record.schedule_id && record.work_date === localDateKey()) || null
  }
  return recentAttendance.find(record => record.schedule_id === scheduleId) || null
}

function currentAttendanceRecord() {
  const openRecord = openAttendanceRecord()
  if (openRecord) return openRecord
  if (selectedSchedule()) return attendanceForSelectedSchedule()
  return recentAttendance
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

function hasAttendanceForSchedule(schedule) {
  return Boolean(schedule?.id) && recentAttendance.some(record => record.schedule_id === schedule.id)
}

function timeZoneDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

function scheduleLocalDateKey(value, timezone) {
  if (!value) return null
  const parts = timeZoneDateParts(new Date(value), timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function adminAssistClockInDateRange(schedule) {
  const targetDate = schedule?.shift_date || ''
  let minimumDate = targetDate
  const timezone = schedule?.timezone || adminAssistTarget?.timezone || access?.timezone || 'America/New_York'
  const scheduleStartDate = scheduleLocalDateKey(schedule?.shift_start, timezone)
  const scheduleEndDate = scheduleLocalDateKey(schedule?.shift_end, timezone)

  if (
    scheduleStartDate === offsetDateKey(targetDate, -1) &&
    scheduleEndDate >= targetDate
  ) {
    minimumDate = scheduleStartDate
  }

  return { min: minimumDate, max: targetDate }
}

function isHistoricalAdminAssistClockInRequired(schedule, now = new Date()) {
  return adminAssistMode &&
    Boolean(schedule) &&
    scheduleAvailability(schedule, now).state === 'ended' &&
    !hasAttendanceForSchedule(schedule)
}

function localDateTimeToISOString(value, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '')
  if (!match) return null

  const [, year, month, day, hour, minute] = match
  const naiveMilliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  )
  let candidateMilliseconds = naiveMilliseconds

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = timeZoneDateParts(new Date(candidateMilliseconds), timezone)
    const displayedMilliseconds = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute)
    )
    candidateMilliseconds -= displayedMilliseconds - naiveMilliseconds
  }

  const candidate = new Date(candidateMilliseconds)
  const roundTrip = timeZoneDateParts(candidate, timezone)
  if (
    roundTrip.year !== year ||
    roundTrip.month !== month ||
    roundTrip.day !== day ||
    roundTrip.hour !== hour ||
    roundTrip.minute !== minute
  ) return null

  return candidate.toISOString()
}

function renderAdminAssistHistoricalClockIn(schedule, now = new Date()) {
  const required = isHistoricalAdminAssistClockInRequired(schedule, now)
  elements.adminAssistHistoricalClockIn.hidden = !required
  elements.adminAssistClockInDate.disabled = !required || busy
  elements.adminAssistClockInTime.disabled = !required || busy

  if (!required) {
    adminAssistHistoricalClockInScheduleId = ''
    elements.adminAssistClockInDate.value = ''
    elements.adminAssistClockInTime.value = ''
    return
  }

  const range = adminAssistClockInDateRange(schedule)
  elements.adminAssistClockInDate.min = range.min
  elements.adminAssistClockInDate.max = range.max
  elements.adminAssistClockInHelp.textContent =
    range.min === range.max
      ? `Enter the target employee’s actual local Clock In time on ${range.max}.`
      : `Enter the target employee’s actual local Clock In time on ${range.min} or ${range.max}.`

  if (adminAssistHistoricalClockInScheduleId !== schedule.id) {
    adminAssistHistoricalClockInScheduleId = schedule.id
    elements.adminAssistClockInDate.value = range.max
    elements.adminAssistClockInTime.value = ''
  }
}

function readHistoricalAdminAssistClockIn(schedule) {
  if (!isHistoricalAdminAssistClockInRequired(schedule)) return { timestamp: null }

  const date = elements.adminAssistClockInDate.value
  const time = elements.adminAssistClockInTime.value
  const range = adminAssistClockInDateRange(schedule)
  if (!date || !time) {
    return { error: 'Enter the actual historical Clock In date and time.' }
  }
  if (date < range.min || date > range.max) {
    return { error: 'The historical Clock In date is outside the selected schedule window.' }
  }

  const timezone = schedule.timezone || adminAssistTarget?.timezone || access?.timezone || 'America/New_York'
  const timestamp = localDateTimeToISOString(`${date}T${time}`, timezone)
  if (!timestamp) {
    return { error: 'Enter a valid historical Clock In time.' }
  }
  if (Date.parse(timestamp) > Date.now()) {
    return { error: 'Historical Clock In cannot be in the future.' }
  }
  return { timestamp }
}

function scheduleOptionLabel(
  schedule,
  availability = scheduleAvailability(schedule),
  { managerAssist = false, hasAttendance = false, now = new Date() } = {}
) {
  const baseLabel = formatScheduleOptionLabel(schedule, access?.timezone)
  const relativeDateLabel = relativeScheduleDateLabel(schedule.shift_date, now)
  const statusLabel = schedule.status === 'changed' ? ' · Changed' : ''
  const overtimeLabel = schedule.is_rest_day
    ? ' · RDOT'
    : schedule.is_holiday
      ? ' · OT'
      : ''
  const availabilityLabel = availability.state === 'ended' ? ' · Ended' : ''
  const attendanceLabel = managerAssist && hasAttendance ? ' · Attendance recorded' : ''
  return [
    relativeDateLabel,
    baseLabel,
    overtimeLabel.replace(/^ · /, ''),
    statusLabel.replace(/^ · /, ''),
    availabilityLabel.replace(/^ · /, ''),
    attendanceLabel.replace(/^ · /, '')
  ].filter(Boolean).join(' · ')
}

function renderScheduleChooser() {
  const previous = elements.scheduleSelect.value
  const now = new Date()
  const leaveSchedules = todaySchedules
    .filter(schedule => schedule.is_leave && !schedule.is_absent)
    .slice()
    .sort((left, right) => left.shift_date.localeCompare(right.shift_date) || (left.shift_sequence || 0) - (right.shift_sequence || 0))
  const displayedSchedules = visibleSchedules
    .filter(schedule => adminAssistMode || scheduleAvailability(schedule, now).state !== 'ended')
    .slice()
    .sort((left, right) => {
      const leftTime = left.shift_start ? new Date(left.shift_start).getTime() : parseDateKey(left.shift_date).getTime()
      const rightTime = right.shift_start ? new Date(right.shift_start).getTime() : parseDateKey(right.shift_date).getTime()
      return leftTime - rightTime
    })

  elements.scheduleSelect.replaceChildren()

  if (displayedSchedules.length) {
    const assignedGroup = document.createElement('optgroup')
    assignedGroup.label = 'Assigned schedules'
    const placeholder = new Option('Select a schedule', SCHEDULE_PLACEHOLDER)
    placeholder.disabled = true
    assignedGroup.appendChild(placeholder)
    displayedSchedules.forEach(schedule => {
      const availability = scheduleAvailability(schedule, now)
      const hasAttendance = hasAttendanceForSchedule(schedule)
      const option = new Option(
        scheduleOptionLabel(schedule, availability, {
          managerAssist: adminAssistMode,
          hasAttendance,
          now
        }),
        schedule.id
      )
      option.disabled = adminAssistMode ? hasAttendance : availability.state === 'ended'
      assignedGroup.appendChild(option)
    })
    elements.scheduleSelect.appendChild(assignedGroup)

    if (canClockAdditionalSession()) {
      const additionalGroup = document.createElement('optgroup')
      additionalGroup.label = 'Additional session'
      additionalGroup.appendChild(new Option(`${formatScheduleDateLabel(activeLocalDate, now)} · Additional work session · Needs review`, ADDITIONAL_WORK_SESSION))
      elements.scheduleSelect.appendChild(additionalGroup)
    }

    const optionValues = [...elements.scheduleSelect.options].map(option => option.value)
    const availableSchedule = displayedSchedules.find(schedule => {
      const alreadyRecorded = recentAttendance.some(record =>
        record.schedule_id === schedule.id && Boolean(record.clock_in)
      )
      const availability = scheduleAvailability(schedule, now)
      return !alreadyRecorded && [
        'next-day-special',
        'special',
        'early',
        'active'
      ].includes(availability.state)
    })
    const preferred = optionValues.includes(previous) && previous
      ? previous
      : displayedSchedules.length === 1
        ? displayedSchedules[0].id
        : SCHEDULE_PLACEHOLDER

    elements.scheduleSelect.value = preferred
    elements.scheduleChooser.hidden = false
  } else {
    const assignedGroup = document.createElement('optgroup')
    assignedGroup.label = 'Assigned schedules'
    const unscheduledOption = new Option('Unscheduled attendance', SCHEDULE_PLACEHOLDER)
    unscheduledOption.disabled = true
    assignedGroup.appendChild(unscheduledOption)
    elements.scheduleSelect.appendChild(assignedGroup)
    elements.scheduleChooser.hidden = false
    elements.scheduleSelect.value = SCHEDULE_PLACEHOLDER
  }

  if (leaveSchedules.length) {
    const leaveGroup = document.createElement('optgroup')
    leaveGroup.label = 'Leave schedules'
    leaveSchedules.forEach(schedule => {
      const option = new Option(leaveScheduleOptionLabel(schedule, now), schedule.id)
      option.disabled = true
      leaveGroup.appendChild(option)
    })
    elements.scheduleSelect.appendChild(leaveGroup)
  }

  if (paidLeaveWorkOptionEligible(now)) {
    const vlGroup = document.createElement('optgroup')
    vlGroup.label = 'Paid leave work'
    vlGroup.appendChild(new Option(`${formatScheduleDateLabel(localDateKey(now), now)} · Work on VL · Needs review`, WORK_ON_VL))
    elements.scheduleSelect.appendChild(vlGroup)
    elements.scheduleChooser.hidden = false
  }

  if (canClockAdditionalSession() && ![...elements.scheduleSelect.options].some(option => option.value === ADDITIONAL_WORK_SESSION)) {
    const additionalGroup = document.createElement('optgroup')
    additionalGroup.label = 'Additional session'
    additionalGroup.appendChild(new Option(`${formatScheduleDateLabel(activeLocalDate, now)} · Additional work session · Needs review`, ADDITIONAL_WORK_SESSION))
    elements.scheduleSelect.appendChild(additionalGroup)
    elements.scheduleChooser.hidden = false
  }

  if (previous && [...elements.scheduleSelect.options].some(option => option.value === previous)) {
    elements.scheduleSelect.value = previous
  }
}

function renderScheduleNotice() {
  const selected = selectedSchedule()
  const changedSchedules = visibleSchedules.filter(schedule => schedule.status === 'changed')
  const paidLeaveToday = todaySchedules.some(schedule =>
    schedule.shift_date === activeLocalDate &&
    schedule.is_leave &&
    ['incentive_vl', 'birthday_vl'].includes(schedule.leave_type)
  )

  elements.scheduleNotice.hidden = true
  elements.scheduleNotice.className = 'attendance-notice'
  elements.scheduleNotice.textContent = ''

  if (paidLeaveToday) {
    elements.scheduleNotice.textContent = 'Paid Leave — work hours will be additional.'
    elements.scheduleNotice.hidden = false
  }

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

  if (isWorkOnVLSelected()) {
    elements.scheduleHelp.textContent = 'This paid VL date remains leave. Work will be recorded separately as pending attendance for manager review.'
    return
  }

  if (!schedule) {
    elements.scheduleHelp.textContent = canClockAdditionalSession()
      ? 'No assigned second shift found. Clock in as an additional work session for admin review.'
      : 'No assigned schedule. Your time will be recorded as unscheduled attendance.'
    return
  }

  if (record?.clock_in && record.clock_out) {
    elements.scheduleHelp.textContent = 'Attendance for this shift or work date has already been completed.'
    return
  }

  const availability = scheduleAvailability(schedule)
  if (adminAssistMode && !hasAttendanceForSchedule(schedule) && availability.state === 'ended') {
    elements.scheduleHelp.textContent = 'This ended schedule is available for an audited manager-assisted clock-in on its scheduled work date.'
  } else if (availability.state === 'next-day-special') {
    elements.scheduleHelp.textContent = schedule.is_rest_day
      ? 'Today’s attendance is complete. You can clock in early for tomorrow’s rest day, and all credited worked minutes will count as RDOT.'
      : 'Today’s attendance is complete. You can clock in early for tomorrow’s holiday, and all credited worked minutes will count as overtime.'
  } else if (availability.state === 'next-day-overnight') {
    elements.scheduleHelp.textContent = 'This early-morning shift is available for clock-in before midnight. The attendance will belong to the scheduled work date.'
  } else if (availability.state === 'special') {
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
    elements.scheduleHelp.textContent = isOpenSchedule(schedule)
      ? 'This Open Schedule work date has ended and is no longer available for clock-in.'
      : 'This shift or work date has ended and is no longer available for clock-in.'
  } else if (availability.state === 'future') {
    elements.scheduleHelp.textContent = isOpenSchedule(schedule)
      ? 'Open Schedule clock-in opens on the scheduled work date.'
      : 'Rest-day and holiday clock-in opens on the scheduled work date.'
  } else if (availability.state === 'open') {
    elements.scheduleHelp.textContent = 'This is an open schedule. Clock-in is available today; no fixed shift times are required.'
  } else if (availability.state === 'unavailable') {
    elements.scheduleHelp.textContent = 'This schedule is missing required shift times and cannot be used for self-service clock-in.'
  } else {
    elements.scheduleHelp.textContent = 'This schedule is not available for self-service clock-in.'
  }
}

function updateActionState() {
  const openRecord = openAttendanceRecord()
  const schedule = selectedSchedule()
  const selectedRecord = attendanceForSelectedSchedule()
  const hasExplicitSelection = Boolean(schedule) || isAdditionalWorkSessionSelected() || isWorkOnVLSelected()
  const availability = schedule ? scheduleAvailability(schedule) : null
  renderAdminAssistHistoricalClockIn(schedule, new Date())
  const scheduleClockInOpen = adminAssistMode
    ? Boolean(schedule) &&
      !hasAttendanceForSchedule(schedule) &&
      (['ended', 'next-day-special', 'next-day-overnight', 'special', 'early', 'active'].includes(availability.state) ||
        isUntimedRestDayWithinClockInWindow(schedule))
    : schedule
      ? ['next-day-special', 'next-day-overnight', 'special', 'early', 'active'].includes(availability.state) ||
        availability.state === 'open' ||
        isUntimedRestDayWithinClockInWindow(schedule)
      : (isAdditionalWorkSessionSelected() && canClockAdditionalSession()) ||
        (isWorkOnVLSelected() && paidLeaveWorkOptionEligible())
  const selectedCompleted = Boolean(selectedRecord?.clock_in && selectedRecord.clock_out)

  elements.clockInButton.disabled = busy || Boolean(openRecord) || selectedCompleted || !hasExplicitSelection || !scheduleClockInOpen
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
  const sequenceLabel = displaySchedule?.shift_start && displaySchedule?.shift_end
    ? `Work Schedule · Sequence ${displaySchedule.shift_sequence || 1}`
    : displaySchedule?.is_leave
      ? 'Paid Leave'
      : displaySchedule?.id
        ? 'Open Schedule'
        : 'Unscheduled attendance'
  elements.todayShift.textContent = displaySchedule
    ? `${sequenceLabel} · ${formatShift(displaySchedule)}`
    : sequenceLabel
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
  const nextLocalDate = localDateKey(now)

  if (!activeLocalDate) {
    activeLocalDate = nextLocalDate
  } else if (nextLocalDate !== activeLocalDate) {
    activeLocalDate = nextLocalDate
    localDateRefreshPending = true
    elements.historyMonth.value = nextLocalDate.slice(0, 7)
    elements.historyPeriod.value = defaultHistoryPeriod(nextLocalDate)
  }

  const clockParts = new Intl.DateTimeFormat('en-US', {
    timeZone: access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).formatToParts(now)

  const clockPart = type =>
    clockParts.find(part => part.type === type)?.value || ''

  elements.liveClockValue.textContent =
    `${clockPart('hour')}:${clockPart('minute')}:${clockPart('second')}`

  elements.liveClockPeriod.textContent = clockPart('dayPeriod')
  elements.liveClock.dateTime = now.toISOString()

  const record = openAttendanceRecord()
  if (record) {
    elements.todayWorked.textContent = formatMinutes(workedMinutes(record, now))
    maybePersistOverDurationFlag(record, now)
  }
  updateActionState()

  if (localDateRefreshPending && !busy) {
    localDateRefreshPending = false
    void refreshAll()
  }
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
  const pendingApproval = !record.is_prepaid_schedule &&
    record.clock_out &&
    !['approved', 'locked'].includes(record.review_status)
  status.className = `wf-badge ${record.is_prepaid_schedule ? 'info' : pendingApproval ? 'warning' : badgeClass(record.attendance_status)}`
  status.textContent = record.is_prepaid_schedule
    ? 'Prepaid scheduled'
    : pendingApproval
      ? 'For review'
      : ATTENDANCE_STATUS_LABELS[record.attendance_status] || record.attendance_status
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

function createPayTypeCell(record) {
  const cell = document.createElement('td')
  const wrap = document.createElement('div')
  wrap.className = 'attendance-pay-type'

  if (record.is_prepaid_schedule) {
    const badge = document.createElement('span')
    badge.className = 'wf-badge info'
    badge.textContent = `Prepaid ${formatMinutes(record.prepaid_minutes)}`
    wrap.appendChild(badge)
  } else {
    const pendingApproval = record.clock_out && !['approved', 'locked'].includes(record.review_status)
    const fulfilledMinutes = Math.max(0, Number(record.fulfilled_prepaid_minutes) || 0)
    const regularMinutes = pendingApproval
      ? 0
      : Math.max(0, Number(record.regular_payable_minutes) || 0)
    if (fulfilledMinutes) {
      const badge = document.createElement('span')
      badge.className = 'wf-badge success'
      badge.textContent = `Prepaid ${formatMinutes(fulfilledMinutes)}`
      wrap.appendChild(badge)
    }
    if (regularMinutes) {
      const badge = document.createElement('span')
      badge.className = 'wf-badge muted'
      badge.textContent = `Regular ${formatMinutes(regularMinutes)}`
      wrap.appendChild(badge)
    }
    if (pendingApproval && !fulfilledMinutes) {
      const badge = document.createElement('span')
      badge.className = 'wf-badge warning'
      badge.textContent = 'For review'
      wrap.appendChild(badge)
    }
  }

  if (!wrap.childElementCount) wrap.textContent = '—'
  cell.appendChild(wrap)
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
  const pageCount = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE))
  historyPage = Math.min(Math.max(1, historyPage), pageCount)
  const pageStart = (historyPage - 1) * HISTORY_PAGE_SIZE
  const visibleRows = rows.slice(pageStart, pageStart + HISTORY_PAGE_SIZE)
  elements.historyBody.replaceChildren()

  if (!visibleRows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 9
    cell.className = 'wf-empty'
    cell.textContent = 'No attendance records match the selected period and status.'
    row.appendChild(cell)
    elements.historyBody.appendChild(row)
  } else {
    visibleRows.forEach(record => {
      const row = document.createElement('tr')
      if (record.is_prepaid_schedule) row.classList.add('attendance-prepaid-schedule-row')
      const schedule = record.work_schedules || null
      const scheduleNote = schedule?.is_rest_day
        ? 'Rest-day overtime'
        : schedule?.is_holiday
          ? 'Holiday overtime'
          : schedule?.status === 'changed'
            ? 'Changed schedule'
            : ''
      const noteCell = document.createElement('td')
      noteCell.className = 'attendance-note-cell'
      noteCell.textContent = formatCorrectionReason(record.correction_reason)

      row.append(
        createTextCell(formatDate(record.work_date), record.corrected_at ? 'Corrected by an administrator' : ''),
        createTextCell(formatShift(schedule), scheduleNote),
        createTextCell(formatTime(record.clock_in)),
        createTextCell(formatTime(record.clock_out)),
        createTextCell(record.clock_in ? formatMinutes(workedMinutes(record)) : '—'),
        createStatusCell(record),
        createPayTypeCell(record),
        createAdjustmentsCell(record),
        noteCell
      )
      elements.historyBody.appendChild(row)
    })
  }

  elements.historyPrevious.disabled = historyPage <= 1
  elements.historyNext.disabled = historyPage >= pageCount
  elements.historyPageStatus.textContent = `Page ${historyPage} of ${pageCount}`

  const rangeLabel = activeHistoryRange
    ? `${formatDate(activeHistoryRange.start, false)}–${formatDate(activeHistoryRange.end, false)}`
    : 'Selected period'
  if (!rows.length) {
    setHistoryMessage(`${rangeLabel} · No matching attendance records.`)
  } else {
    const visibleEnd = Math.min(pageStart + HISTORY_PAGE_SIZE, rows.length)
    setHistoryMessage(`${rangeLabel} · Showing ${pageStart + 1}–${visibleEnd} of ${rows.length} record${rows.length === 1 ? '' : 's'}.`)
  }

  const presentRows = historyRows.filter(record => record.attendance_status === 'present')
  const workedTotal = historyRows.reduce((sum, record) => sum + workedMinutes(record), 0)
  document.getElementById('attendanceMonthCount').textContent = historyRows.length
  document.getElementById('attendancePresentCount').textContent = presentRows.length
  document.getElementById('attendanceLateCount').textContent = historyRows.filter(record => record.is_late).length
  document.getElementById('attendanceWorkedTotal').textContent = formatMinutes(workedTotal)
}

async function loadToday() {
  if (adminAssistMode) {
    await loadAdminAssistSnapshot()
    return
  }
  const today = localDateKey()
  const rangeStart = offsetDateKey(today, -1)
  const rangeEnd = offsetDateKey(today, 1)

  const scheduleQuery = supabase
    .from('work_schedules')
    .select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, leave_type, holiday_name, notes')
    .in('user_id', profileIds)
    .gte('shift_date', rangeStart)
    .lte('shift_date', rangeEnd)
    .in('status', RELEASED_SCHEDULE_STATUSES)
    .order('shift_date')
    .order('shift_sequence')
    .abortSignal(requestSignal())

  const attendanceQuery = supabase
    .from('attendance')
    .select('id, user_id, schedule_id, work_date, clock_in, clock_out, manager_review_reason, attendance_status, is_late, minutes_late, overtime_minutes, pre_shift_overtime_minutes, regular_minutes, post_shift_overtime_minutes, rest_day_overtime_minutes, holiday_overtime_minutes, total_overtime_minutes, total_worked_minutes, undertime_minutes, correction_reason, admin_notes, corrected_at, created_at, updated_at, work_schedules(id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, holiday_name)')
    .in('user_id', profileIds)
    .gte('work_date', rangeStart)
    .lte('work_date', rangeEnd)
    .order('created_at')
    .abortSignal(requestSignal())

  const [scheduleResult, attendanceResult] = await Promise.all([scheduleQuery, attendanceQuery])
  if (scheduleResult.error) throw scheduleResult.error
  if (attendanceResult.error) throw attendanceResult.error

  todaySchedules = scheduleResult.data || []
  visibleSchedules = todaySchedules.filter(schedule => !schedule.is_leave && !schedule.is_absent)
  recentAttendance = (attendanceResult.data || [])
    .map(record => redactAttendanceCorrectionForViewer(access, record))
  renderToday()
}

async function loadHistory() {
  if (adminAssistMode) {
    await loadAdminAssistSnapshot()
    return
  }
  const range = historyRange(elements.historyMonth.value, elements.historyPeriod.value)
  activeHistoryRange = range
  historyPage = 1
  setHistoryMessage('Loading attendance history...')

  const { data, error } = await supabase.rpc(
    'workforce_list_my_attendance_log',
    {
      p_start_date: range.start,
      p_end_date: range.end
    }
  )

  if (error) throw error
  historyRows = (data || []).filter(record => record.review_status !== 'voided').map(record => ({
    ...record,
    work_schedules: record.schedule_id || record.schedule_start
      ? {
          id: record.schedule_id,
          shift_start: record.schedule_start,
          shift_end: record.schedule_end,
          timezone: record.schedule_timezone,
          status: record.schedule_status,
          is_rest_day: record.schedule_is_rest_day,
          is_holiday: record.schedule_is_holiday,
          holiday_name: record.holiday_name
        }
      : null
  }))
  renderHistory()
}

async function loadPrepaidBalances() {
  if (adminAssistMode) {
    renderPrepaidBalances()
    return
  }
  const { data, error } = await supabase.rpc(
    'workforce_list_my_prepaid_balances'
  )

  if (error) throw error
  prepaidBalances = data || []
  renderPrepaidBalances()
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
    await Promise.all([loadToday(), loadHistory(), loadPrepaidBalances()])
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
  const selectedValue = elements.scheduleSelect.value
  const workOnVLSelected = isWorkOnVLSelected()
  if (selectedValue === SCHEDULE_PLACEHOLDER || (!selectedValue && !isAdditionalWorkSessionSelected() && !workOnVLSelected)) {
    setActionMessage('Please select a schedule or additional work session before clocking in.', 'error')
    return
  }
  const scheduleId = selectedValue === ADDITIONAL_WORK_SESSION || workOnVLSelected ? null : selectedValue
  const schedule = selectedSchedule()
  if (adminAssistMode) {
    const reason = assistReason('Clock In')
    if (!reason) {
      setActionMessage('A reason of at least 5 characters is required.', 'error')
      return
    }
    const historicalClockIn = readHistoricalAdminAssistClockIn(schedule)
    if (historicalClockIn.error) {
      setActionMessage(historicalClockIn.error, 'error')
      return
    }
    setBusy(true, 'clock-in')
    try {
      const payload = {
        p_target_user_id: adminAssistTarget.user_id,
        p_schedule_id: scheduleId,
        p_work_date: schedule?.shift_date || localDateKey(),
        p_reason: reason
      }
      if (historicalClockIn.timestamp) payload.p_clock_in = historicalClockIn.timestamp
      const { error } = await supabase.rpc('workforce_admin_assist_clock_in', payload)
      if (error) throw error
      await loadAdminAssistSnapshot()
      setActionMessage('Admin-assisted clock-in recorded.', 'success')
    } catch (error) {
      setActionMessage(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
    return
  }
  setBusy(true, 'clock-in')
  setActionMessage(
    workOnVLSelected
      ? 'Recording work on paid VL for manager review...'
      : schedule?.is_rest_day
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
    await Promise.all([loadToday(), loadHistory(), loadPrepaidBalances()])
    setActionMessage(
      workOnVLSelected
        ? 'Work on VL recorded and sent for manager review.'
        : schedule?.is_rest_day
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
  const openRecord = openAttendanceRecord()
  if (adminAssistMode) {
    const reason = assistReason('Clock Out')
    if (!reason) {
      setActionMessage('A reason of at least 5 characters is required.', 'error')
      return
    }
    setBusy(true, 'clock-out')
    try {
      const { error } = await supabase.rpc('workforce_admin_assist_clock_out', {
        p_target_user_id: adminAssistTarget.user_id,
        p_reason: reason
      })
      if (error) throw error
      await loadAdminAssistSnapshot()
      setActionMessage('Admin-assisted clock-out recorded.', 'success')
    } catch (error) {
      setActionMessage(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
    return
  }
  const workedDuration = formatMinutes(workedMinutes(openRecord, new Date()))
  if (!window.confirm(`Clock out now? Current worked duration: ${workedDuration}.`)) return
  setBusy(true, 'clock-out')
  setActionMessage('Recording your clock-out...')

  try {
    const { error } = await supabase
      .rpc('workforce_clock_out')
      .abortSignal(requestSignal())
    if (error) throw error
    await Promise.all([loadToday(), loadHistory(), loadPrepaidBalances()])
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

  if (!access.allowed) {
    window.alert('Attendance access is available only to active workforce profiles.')
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
  elements.historyPeriod.value = defaultHistoryPeriod()

  const workforceLink = document.getElementById('attendanceWorkforceLink')
  workforceLink.hidden = !(access.is_admin === true && hasWorkforcePermission(access, 'manage_employees'))
  adminAssistAllowed = canUseAdminAssist()
  renderAdminAssistControls()

  elements.clockInButton.addEventListener('click', clockIn)
  elements.clockOutButton.addEventListener('click', clockOut)
  elements.adminAssistEnter.addEventListener('click', () => enterAdminAssist().catch(error => setActionMessage(errorMessage(error), 'error')))
  elements.adminAssistExit.addEventListener('click', () => exitAdminAssist().catch(error => setActionMessage(errorMessage(error), 'error')))
  elements.adminAssistPrevious.addEventListener('click', () => selectAdminAssistEmployee(adminAssistIndex - 1).catch(error => setActionMessage(errorMessage(error), 'error')))
  elements.adminAssistNext.addEventListener('click', () => selectAdminAssistEmployee(adminAssistIndex + 1).catch(error => setActionMessage(errorMessage(error), 'error')))
  elements.refreshButton.addEventListener('click', () => refreshAll())
  elements.scheduleSelect.addEventListener('change', renderToday)
  elements.historyMonth.addEventListener('change', async () => {
    try {
      await loadHistory()
    } catch (error) {
      setHistoryMessage(errorMessage(error), 'error')
    }
  })
  elements.historyPeriod.addEventListener('change', async () => {
    try {
      await loadHistory()
    } catch (error) {
      setHistoryMessage(errorMessage(error), 'error')
    }
  })
  elements.historyStatus.addEventListener('change', () => {
    historyPage = 1
    renderHistory()
  })
  elements.historyPrevious.addEventListener('click', () => {
    if (historyPage <= 1) return
    historyPage -= 1
    renderHistory()
  })
  elements.historyNext.addEventListener('click', () => {
    const selectedStatus = elements.historyStatus.value
    const matchingRows = historyRows.filter(record => !selectedStatus || record.attendance_status === selectedStatus)
    if (historyPage >= Math.max(1, Math.ceil(matchingRows.length / HISTORY_PAGE_SIZE))) return
    historyPage += 1
    renderHistory()
  })

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
