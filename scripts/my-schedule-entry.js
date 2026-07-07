import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const RELEASED_STATUSES = Object.freeze([
  'published',
  'changed',
  'cancelled',
  'completed'
])

function isReleasedStatusFilter(column, values) {
  return column === 'status' &&
    Array.isArray(values) &&
    values.length === RELEASED_STATUSES.length &&
    RELEASED_STATUSES.every(status => values.includes(status))
}

function enableManagerDraftVisibility() {
  const originalFrom = supabase.from.bind(supabase)

  supabase.from = function patchedFrom(table) {
    const builder = originalFrom(table)

    if (table !== 'work_schedules' || typeof builder?.in !== 'function') {
      return builder
    }

    const originalIn = builder.in.bind(builder)
    builder.in = function patchedIn(column, values) {
      if (isReleasedStatusFilter(column, values)) {
        return this
      }

      return originalIn(column, values)
    }

    return builder
  }
}

function keepManagerControlsAvailable() {
  const scheduledOption = document.querySelector(
    '#myScheduleStatus option[value="scheduled"]'
  )

  if (scheduledOption) {
    scheduledOption.disabled = false
  }

  const scope = document.getElementById('myScheduleScope')
  const subtitle = document.getElementById('schedulePageSubtitle')

  if (scope?.value === 'self' && subtitle) {
    subtitle.textContent =
      'View your assigned shifts, including draft schedules, rest days, holidays, and changes.'
  }
}

const access = await loadCurrentWorkforceAccess(supabase)
const canManageSchedules = hasWorkforcePermission(access, 'manage_schedules')

if (canManageSchedules) {
  enableManagerDraftVisibility()
}

await import('./my-schedule.js?v=1')

if (canManageSchedules) {
  window.setTimeout(keepManagerControlsAvailable, 0)

  document.getElementById('myScheduleScope')?.addEventListener('change', () => {
    window.setTimeout(keepManagerControlsAvailable, 0)
  })

  document.getElementById('refreshMyScheduleButton')?.addEventListener('click', () => {
    window.setTimeout(keepManagerControlsAvailable, 0)
  })
}
