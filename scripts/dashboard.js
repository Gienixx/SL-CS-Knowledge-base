import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'

async function logout() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

window.logout = logout

function ensureInviteUserButton(userManagementBtn) {
  if (
    !userManagementBtn ||
    document.getElementById('inviteUserBtn')
  ) {
    return
  }

  const inviteUserBtn =
    document.createElement('a')

  inviteUserBtn.id = 'inviteUserBtn'
  inviteUserBtn.href = './invite-user.html'
  inviteUserBtn.className =
    userManagementBtn.className
  inviteUserBtn.textContent = 'Invite User'
  inviteUserBtn.style.display = 'inline-flex'

  userManagementBtn.insertAdjacentElement(
    'beforebegin',
    inviteUserBtn
  )
}

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

    const email =
      currentUser.email?.trim().toLowerCase()

    if (!email) {
      await supabase.auth.signOut()
      window.location.replace('./login.html')
      return
    }

    const { data: rows, error } = await supabase
      .from('login')
      .select(
        'email, is_admin, can_edit_articles'
      )

    if (error) {
      console.error('LOGIN ERROR:', error)
      alert('Access check failed.')
      return
    }

    const allowedUser = rows?.find(
      row =>
        row.email?.trim().toLowerCase() ===
        email
    )

    if (!allowedUser) {
      alert('Access check failed.')
      return
    }

    const addArticleBtn =
      document.getElementById('addArticleBtn')

    if (addArticleBtn) {
      addArticleBtn.href =
        './article-management.html'
    }

    if (
      allowedUser.can_edit_articles === true &&
      addArticleBtn
    ) {
      addArticleBtn.style.display = 'inline-flex'
    }

    const changePasswordBtn =
      document.getElementById(
        'changePasswordBtn'
      )

    const userManagementBtn =
      document.getElementById(
        'userManagementBtn'
      )

    if (allowedUser.is_admin === true) {
      if (userManagementBtn) {
        userManagementBtn.style.display =
          'inline-flex'
        ensureInviteUserButton(
          userManagementBtn
        )
      }

      if (changePasswordBtn) {
        changePasswordBtn.style.display = 'none'
      }
    } else {
      if (changePasswordBtn) {
        changePasswordBtn.style.display =
          'inline-flex'
      }

      if (userManagementBtn) {
        userManagementBtn.style.display = 'none'
      }
    }

    console.log('ACCESS GRANTED:', email)
  } catch (error) {
    console.error('Dashboard error:', error)
  }
})
