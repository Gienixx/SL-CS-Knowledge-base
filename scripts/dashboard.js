import {
  supabase,
  requiresFirstLoginPasswordChange
} from './supabaseClient.js'

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

    if (requiresFirstLoginPasswordChange(user)) {
      window.location.replace(
        './change-password.html?firstLogin=1'
      )
      return
    }

    const email = user.email?.trim().toLowerCase()

    if (!email) {
      await supabase.auth.signOut()
      window.location.replace('./login.html')
      return
    }

    const { data: rows, error } = await supabase
      .from('login')
      .select('email, is_admin, can_edit_articles')

    if (error) {
      console.error('LOGIN ERROR:', error)
      alert('Access check failed.')
      return
    }

    const allowedUser = rows?.find(
      row => row.email?.trim().toLowerCase() === email
    )

    if (!allowedUser) {
      alert('Access check failed.')
      return
    }

    const addArticleBtn = document.getElementById('addArticleBtn')

    if (
      allowedUser.can_edit_articles === true &&
      addArticleBtn
    ) {
      addArticleBtn.style.display = 'inline-flex'
    }

    const changePasswordBtn =
      document.getElementById('changePasswordBtn')

    const userManagementBtn =
      document.getElementById('userManagementBtn')

    if (allowedUser.is_admin === true) {
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

    console.log('ACCESS GRANTED:', email)
  } catch (error) {
    console.error('Dashboard error:', error)
  }
})
