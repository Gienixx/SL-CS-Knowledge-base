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

    const changePasswordBtn =
      document.getElementById('changePasswordBtn')

    const userManagementBtn =
      document.getElementById('userManagementBtn')

    const canManageEmployees =
      access.is_admin === true &&
      hasWorkforcePermission(access, 'manage_employees')

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

    console.log(
      'ACCESS GRANTED:',
      email,
      access.access_type,
      access.source
    )
  } catch (error) {
    console.error('Dashboard error:', error)
  }
})
