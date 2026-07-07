import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

async function configureHomeWorkforceNavigation() {
  const myScheduleButton = document.getElementById('homeMyScheduleBtn')
  const workforceManagementButton = document.getElementById(
    'homeWorkforceManagementBtn'
  )

  if (!myScheduleButton && !workforceManagementButton) {
    return
  }

  try {
    const access = await loadCurrentWorkforceAccess(supabaseClient())

    if (!access.allowed) {
      return
    }

    const canViewSchedules =
      access.is_agent === true ||
      hasWorkforcePermission(access, 'manage_schedules')

    const canManageEmployees =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'manage_employees')

    if (myScheduleButton) {
      myScheduleButton.hidden = !canViewSchedules
    }

    if (workforceManagementButton) {
      workforceManagementButton.hidden = !canManageEmployees
    }
  } catch (error) {
    console.error('Home workforce navigation failed:', error)
  }
}

function supabaseClient() {
  return window.__socialLoopSupabase
}

document.addEventListener('DOMContentLoaded', configureHomeWorkforceNavigation)
