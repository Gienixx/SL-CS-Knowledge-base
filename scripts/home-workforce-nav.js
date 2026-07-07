import { supabase } from './supabaseClient.js?v=8'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

async function configureHomeWorkforceNavigation() {
  const myScheduleButton = document.getElementById('homeMyScheduleBtn')
  const attendanceButton = document.getElementById('homeAttendanceBtn')
  const workforceManagementButton = document.getElementById(
    'homeWorkforceManagementBtn'
  )

  if (!myScheduleButton && !attendanceButton && !workforceManagementButton) {
    return
  }

  try {
    const access = await loadCurrentWorkforceAccess(supabase)

    if (!access.allowed) {
      return
    }

    const canViewSchedules =
      access.is_agent === true ||
      hasWorkforcePermission(access, 'manage_schedules')

    const canUseAttendance = access.is_agent === true

    const canManageEmployees =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'manage_employees')

    if (myScheduleButton) {
      myScheduleButton.hidden = !canViewSchedules
    }

    if (attendanceButton) {
      attendanceButton.hidden = !canUseAttendance
    }

    if (workforceManagementButton) {
      workforceManagementButton.hidden = !canManageEmployees
    }
  } catch (error) {
    console.error('Home workforce navigation failed:', error)
  }
}

document.addEventListener('DOMContentLoaded', configureHomeWorkforceNavigation)
