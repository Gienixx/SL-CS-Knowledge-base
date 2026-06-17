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

    const { data: allowedUser, error } = await supabase
      .from('login')
      .select('email')
      .eq('email', user.email)
      .single()

    console.log('AUTH USER:', user.email)
    console.log('LOGIN MATCH:', allowedUser)

    if (error || !allowedUser) {
      await supabase.auth.signOut()

      alert('You are not authorized to access this site.')

      window.location.href = './login.html'

      return
    }

    console.log('Dashboard access granted')

  } catch (error) {
    console.error(error)

    window.location.href = './login.html'
  }
})
