import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'
import {
  initializePhaseOneDashboard
} from './dashboard-metrics.js?v=1'
import {
  initializeDistributionDashboard
} from './dashboard-distributions.js?v=2'
import {
  initializeProductivityDashboard
} from './dashboard-productivity-v2.js?v=2'

function isMissingAuthSession(error) {
  return error?.name === 'AuthSessionMissingError'
}

async function logout() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

window.logout = logout

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser()

    if (isMissingAuthSession(userError)) {
      window.location.replace('./login.html')
      return
    }

    if (userError) {
      throw userError
    }

    if (!user) {
      window.location.replace('./login.html')
      return
    }

    let currentUser = user

    if (requiresFirstLoginPasswordChange(currentUser)) {
      const {
        data: { session },
        error: refreshError
      } = await supabase.auth.refreshSession()

      if (!refreshError && session?.user) {
        currentUser = session.user
      }

      if (requiresFirstLoginPasswordChange(currentUser)) {
        window.location.replace(
          './change-password.html?firstLogin=1'
        )
        return
      }
    }

    const email = currentUser.email?.trim().toLowerCase()

    if (!email) {
      await supabase.auth.signOut()
      window.location.replace('./login.html')
      return
    }

    const access = await loadCurrentWorkforceAccess(supabase)

    if (!access.allowed) {
      alert('Access check failed.')
      return
    }

    const addArticleBtn = document.getElementById('addArticleBtn')

    if (addArticleBtn) {
      addArticleBtn.href = './article-management.html'
      addArticleBtn.style.display = hasWorkforcePermission(
        access,
        'edit_articles'
      )
        ? 'inline-flex'
        : 'none'
    }

    const reportingOperationsBtn =
      document.getElementById('reportingOperationsBtn')

    const canViewReportingOperations =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'view_workforce_reports')

    if (reportingOperationsBtn) {
      reportingOperationsBtn.style.display = canViewReportingOperations
        ? 'inline-flex'
        : 'none'
    }

    const myScheduleBtn = document.getElementById('myScheduleBtn')
    const canViewSchedules =
      access.is_agent === true ||
      hasWorkforcePermission(access, 'manage_schedules')

    if (myScheduleBtn) {
      myScheduleBtn.style.display = canViewSchedules
        ? 'inline-flex'
        : 'none'
    }

    const changePasswordBtn =
      document.getElementById('changePasswordBtn')

    const userManagementBtn =
      document.getElementById('userManagementBtn')

    const workforceManagementBtn =
      document.getElementById('workforceManagementBtn')

    const canManageEmployees =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'manage_employees')

    if (workforceManagementBtn) {
      workforceManagementBtn.style.display = canManageEmployees
        ? 'inline-flex'
        : 'none'
    }

    if (canManageEmployees) {
      if (userManagementBtn) {
        userManagementBtn.style.display = 'inline-flex'
      }

      if (changePasswordBtn) {
        changePasswordBtn.style.display = 'none'
      }
    } else {
      if (changePasswordBtn) {
        changePasswordBtn.style.display = 'inline-flex'
      }

      if (userManagementBtn) {
        userManagementBtn.style.display = 'none'
      }
    }

    await initializePhaseOneDashboard()
    await initializeDistributionDashboard()
    await initializeProductivityDashboard()

    const board = document.querySelector('.dashboard-board')

    if (board) {
      board.classList.remove('dashboard-loading-board')
      board.setAttribute('aria-busy', 'false')
    }

  } catch (error) {
    if (isMissingAuthSession(error)) {
      window.location.replace('./login.html')
      return
    }

    console.error('Dashboard error:', error)
  }
})
