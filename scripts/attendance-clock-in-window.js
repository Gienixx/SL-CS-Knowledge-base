import { supabase } from './supabaseClient.js?v=9'

const EARLY_CLOCK_IN_WINDOW_MINUTES = 15
const CACHE_TTL_MS = 30_000

const clockInButton = document.getElementById('attendanceClockInButton')
const scheduleSelect = document.getElementById('attendanceScheduleSelect')
const scheduleHelp = document.getElementById('attendanceScheduleHelp')
const refreshButton = document.getElementById('attendanceRefreshButton')

const scheduleCache = new Map()
let timer = null
let lastScheduleId = ''

function formatOpeningTime(value, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

async function loadSchedule(scheduleId) {
  const cached = scheduleCache.get(scheduleId)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.schedule
  }

  const { data, error } = await supabase
    .from('work_schedules')
    .select('id, shift_start, timezone, status, is_rest_day')
    .eq('id', scheduleId)
    .maybeSingle()

  if (error) {
    console.warn('Unable to load the selected shift clock-in window:', error)
    return null
  }

  scheduleCache.set(scheduleId, {
    loadedAt: Date.now(),
    schedule: data || null
  })

  return data || null
}

function releaseClockInWindowBlock() {
  const wasBlocked = clockInButton?.dataset.clockWindowBlocked === 'true'

  if (!clockInButton) return

  delete clockInButton.dataset.clockWindowBlocked
  clockInButton.removeAttribute('title')

  if (wasBlocked && scheduleSelect) {
    scheduleSelect.dispatchEvent(new Event('change'))
  }
}

async function syncClockInWindow() {
  if (!clockInButton || !scheduleSelect || document.hidden) return

  const scheduleId = scheduleSelect.value
  if (!scheduleId) {
    releaseClockInWindowBlock()
    lastScheduleId = ''
    return
  }

  const schedule = await loadSchedule(scheduleId)
  if (
    !schedule ||
    schedule.is_rest_day ||
    !['published', 'changed'].includes(schedule.status) ||
    !schedule.shift_start
  ) {
    releaseClockInWindowBlock()
    return
  }

  const shiftStart = new Date(schedule.shift_start).getTime()
  const clockInOpens = shiftStart - EARLY_CLOCK_IN_WINDOW_MINUTES * 60_000
  const now = Date.now()

  if (now < clockInOpens) {
    const openingLabel = formatOpeningTime(clockInOpens, schedule.timezone)
    const message = `Clock-in opens at ${openingLabel}, 15 minutes before your shift. Early clock-in minutes are recorded as overtime.`

    clockInButton.dataset.clockWindowBlocked = 'true'
    clockInButton.disabled = true
    clockInButton.title = message

    if (scheduleHelp) scheduleHelp.textContent = message
    lastScheduleId = scheduleId
    return
  }

  const wasBlocked = clockInButton.dataset.clockWindowBlocked === 'true'
  releaseClockInWindowBlock()

  if (now < shiftStart && scheduleHelp) {
    scheduleHelp.textContent = 'Clock-in is open. Minutes worked before the scheduled start are recorded as overtime.'
  } else if (wasBlocked || lastScheduleId !== scheduleId) {
    scheduleSelect.dispatchEvent(new Event('change'))
  }

  lastScheduleId = scheduleId
}

scheduleSelect?.addEventListener('change', () => {
  void syncClockInWindow()
})

refreshButton?.addEventListener('click', () => {
  scheduleCache.clear()
  window.setTimeout(() => void syncClockInWindow(), 500)
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void syncClockInWindow()
})

void syncClockInWindow()
timer = window.setInterval(() => void syncClockInWindow(), 1000)

window.addEventListener('pagehide', () => {
  if (timer) window.clearInterval(timer)
}, { once: true })
