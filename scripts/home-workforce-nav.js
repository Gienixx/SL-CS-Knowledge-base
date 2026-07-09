import { supabase } from './supabaseClient.js?v=8'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

function ensureTeamAttendanceButton(attendanceButton) {
  let teamAttendanceButton = document.getElementById('homeTeamAttendanceBtn')

  if (teamAttendanceButton || !attendanceButton?.parentElement) {
    return teamAttendanceButton
  }

  teamAttendanceButton = document.createElement('a')
  teamAttendanceButton.id = 'homeTeamAttendanceBtn'
  teamAttendanceButton.className = 'sidebar-link'
  teamAttendanceButton.href = './team-attendance.html'
  teamAttendanceButton.title = 'Team Attendance'
  teamAttendanceButton.hidden = true

  const icon = document.createElement('span')
  icon.className = 'sidebar-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '◉'

  const label = document.createElement('span')
  label.textContent = 'Team Attendance'

  teamAttendanceButton.append(icon, label)
  attendanceButton.insertAdjacentElement('afterend', teamAttendanceButton)
  return teamAttendanceButton
}

async function configureHomeWorkforceNavigation() {
  const myScheduleButton = document.getElementById('homeMyScheduleBtn')
  const attendanceButton = document.getElementById('homeAttendanceBtn')
  const teamAttendanceButton = ensureTeamAttendanceButton(attendanceButton)
  const workforceManagementButton = document.getElementById(
    'homeWorkforceManagementBtn'
  )

  if (
    !myScheduleButton &&
    !attendanceButton &&
    !teamAttendanceButton &&
    !workforceManagementButton
  ) {
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
    const canViewTeamAttendance = hasWorkforcePermission(
      access,
      'view_team_attendance'
    )

    const canManageEmployees =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'manage_employees')

    if (myScheduleButton) {
      myScheduleButton.hidden = !canViewSchedules
    }

    if (attendanceButton) {
      attendanceButton.hidden = !canUseAttendance
    }

    if (teamAttendanceButton) {
      teamAttendanceButton.hidden = !canViewTeamAttendance
    }

    if (workforceManagementButton) {
      workforceManagementButton.hidden = !canManageEmployees
    }
  } catch (error) {
    console.error('Home workforce navigation failed:', error)
  }
}

document.addEventListener('DOMContentLoaded', configureHomeWorkforceNavigation)
