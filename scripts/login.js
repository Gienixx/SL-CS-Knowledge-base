import { supabase } from './supabaseClient.js'

const loginForm = document.getElementById('loginForm')
const loginStatus = document.getElementById('loginStatus')

const {
  data: { user }
} = await supabase.auth.getUser()

if (user) {
  window.location.replace('./dashboard.html')
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()

  const email = document.getElementById('email').value.trim()
  const password = document.getElementById('password').value

  loginStatus.textContent = 'Signing in...'
  loginStatus.className = 'status'

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  })

  if (error) {
    loginStatus.textContent = error.message
    loginStatus.className = 'status error'
    return
  }

  loginStatus.textContent = 'Login successful. Redirecting...'
  loginStatus.className = 'status success'

  window.location.href = './dashboard.html'
})
