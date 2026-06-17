import { supabase } from './supabaseClient.js'

async function logout() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

window.logout = logout

document.addEventListener('DOMContentLoaded', async () => {
  try {

    const {
      data: { user }
    } = await supabase.auth.getUser()

    if (!user) {
      window.location.href = './login.html'
      return
    }

    const email = user.email.trim().toLowerCase()

    const { data: rows, error } = await supabase
      .from('login')
      .select('email')

    console.log('AUTH EMAIL:', email)
    console.log('LOGIN ROWS:', rows)
    console.log('LOGIN ERROR:', error)

    const allowedUser = rows?.find(
      row =>
        row.email?.trim().toLowerCase() === email
    )

    console.log('ALLOWED USER:', allowedUser)

    if (!allowedUser) {
      alert('Access check failed. Check console.')
      return
    }

    console.log('ACCESS GRANTED')

  } catch (error) {
    console.error('Dashboard error:', error)
  }
})
