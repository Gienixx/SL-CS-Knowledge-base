import { supabase } from './supabaseClient.js'

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

    console.log('AUTH USER:', user)
    console.log('AUTH ERROR:', userError)

    if (userError || !user) {
      window.location.href = './login.html'
      return
    }

    const email = user.email.trim().toLowerCase()

    const { data: allowedUser, error: allowedError } = await supabase
      .from('login')
      .select('email')
      .ilike('email', email)
      .maybeSingle()

    console.log('CHECKING EMAIL:', email)
    console.log('ALLOWED USER:', allowedUser)
    console.log('ALLOWED ERROR:', allowedError)

    if (allowedError || !allowedUser) {
      await supabase.auth.signOut()
      alert('You are not authorized to access this site.')
      window.location.href = './login.html'
      return
    }

    console.log('Dashboard access granted:', email)

  } catch (error) {
    console.error('Dashboard auth error:', error)
    window.location.href = './login.html'
  }
})
