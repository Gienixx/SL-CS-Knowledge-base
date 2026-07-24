import { supabase } from './supabaseClient.js?v=10'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

async function configureHomeWorkforceNavigation() {
  const myScheduleButton = document.getElementById('homeMyScheduleBtn')
  const attendanceButton = document.getElementById('homeAttendanceBtn')
  const leaveRequestsButton = document.getElementById('homeLeaveRequestsBtn')
  const teamAttendanceButton = document.getElementById('homeTeamAttendanceBtn')
  const workforceManagementButton = document.getElementById(
    'homeWorkforceManagementBtn'
  )
  const payrollDashboardButton = document.getElementById(
    'homePayrollDashboardBtn'
  )

  if (
    !myScheduleButton &&
    !attendanceButton &&
    !leaveRequestsButton &&
    !teamAttendanceButton &&
    !workforceManagementButton &&
    !payrollDashboardButton
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
    const canAccessPayrollDashboard = [
      'create_payroll',
      'review_payroll',
      'finalize_payroll',
      'reopen_payroll'
    ].some(permission => hasWorkforcePermission(access, permission))

    if (myScheduleButton) {
      myScheduleButton.hidden = !canViewSchedules
    }

    if (attendanceButton) {
      attendanceButton.hidden = !canUseAttendance
    }

    if (leaveRequestsButton) {
      leaveRequestsButton.hidden = !access.allowed
    }

    if (teamAttendanceButton) {
      teamAttendanceButton.hidden = !canViewTeamAttendance
    }

    if (workforceManagementButton) {
      workforceManagementButton.hidden = !canManageEmployees
    }

    if (payrollDashboardButton) {
      payrollDashboardButton.hidden = !canAccessPayrollDashboard
    }
  } catch (error) {
    console.error('Home workforce navigation failed:', error)
  }
}

document.addEventListener('DOMContentLoaded', configureHomeWorkforceNavigation)
