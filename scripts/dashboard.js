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

    const { data: allowedUser, error } = await supabase
        .from('login')
        .select('email')
        .eq('email', email)
        .maybeSingle()

    if (error || !allowedUser) {
      console.log('WHITELIST ERROR:', error)
      console.log('ALLOWED USER:', allowedUser)
        alert('Access check failed. Check console.')
    return
  }

    console.log('Dashboard access granted')

  } catch (error) {
    console.error(error)

    window.location.href = './login.html'
  }
})
