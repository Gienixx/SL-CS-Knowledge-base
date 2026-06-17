import { supabase } from './supabaseClient.js'

async function logout() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

window.logout = logout

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const auth = await supabase.auth.getUser()

    console.log('AUTH:', auth)

    const user = auth?.data?.user

    if (!user) {
      alert('No logged in user')
      window.location.href = './login.html'
      return
    }

    const email = user.email?.trim()

    console.log('USER EMAIL:', email)

    const result = await supabase
      .from('login')
      .select('*')

    console.log('LOGIN TABLE:', result)

    const allowed =
      result.data?.find(
        row =>
          row.email?.trim().toLowerCase() ===
          email?.toLowerCase()
      )

    console.log('MATCH:', allowed)

    if (!allowed) {
      alert(
        `Email not found in login table:\n${email}`
      )

      return
    }

    console.log('ACCESS GRANTED')

  } catch (err) {
    console.error(err)
  }
})
