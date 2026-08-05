import { supabase } from './supabaseClient.js?v=11'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

async function configureHomeWorkforceNavigation() {
  const myScheduleButton = document.getElementById('homeMyScheduleBtn')
  const attendanceButton = document.getElementById('homeAttendanceBtn')
  const leaveRequestsButton = document.getElementById('homeLeaveRequestsBtn')
  const leaveRequestsPendingBadge = document.getElementById(
    'homeLeaveRequestsPendingBadge'
  )
  const myPayslipsButton = document.getElementById('homeMyPayslipsBtn')
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
    !myPayslipsButton &&
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

    const canUseAttendance = access.allowed === true
    const isRegularAgentView = access.access_type === 'regular_agent'
    const canApproveLeave =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'approve_leave')
    const canUseLeaveRequests = access.is_agent === true || canApproveLeave
    const canViewTeamAttendance = access.is_admin === true
      ? hasWorkforcePermission(access, 'view_team_attendance')
      : access.is_agent === true
    const canViewOwnPayslips = hasWorkforcePermission(
      access,
      'view_own_payslips'
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
      leaveRequestsButton.hidden = !canUseLeaveRequests

      if (canApproveLeave && leaveRequestsPendingBadge) {
        const refreshPendingLeaveCount = async () => {
          const { count, error } = await supabase
            .from('leave_requests')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending')

          if (error) {
            console.error('Pending leave request count failed:', error)
            return
          }

          const pendingCount = Number(count || 0)
          leaveRequestsPendingBadge.textContent = pendingCount > 99
            ? '99+'
            : String(pendingCount)
          leaveRequestsPendingBadge.hidden = pendingCount === 0
          leaveRequestsPendingBadge.setAttribute(
            'aria-label',
            `${pendingCount} pending leave request${pendingCount === 1 ? '' : 's'}`
          )
          leaveRequestsButton.title = pendingCount
            ? `${pendingCount} leave request${pendingCount === 1 ? '' : 's'} waiting for approval`
            : ''
        }

        await refreshPendingLeaveCount()
        window.setInterval(refreshPendingLeaveCount, 60000)
        window.addEventListener('focus', refreshPendingLeaveCount)
      }
    }

    if (myPayslipsButton) {
      myPayslipsButton.hidden = isRegularAgentView || !canViewOwnPayslips
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
