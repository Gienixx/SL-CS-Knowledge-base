import { supabase } from './supabaseClient.js'

const loginForm = document.getElementById('loginForm')
const loginStatus = document.getElementById('loginStatus')

function getSafeRedirectPath() {
  const redirectTo = new URLSearchParams(window.location.search).get('redirectTo')

  if (!redirectTo) {
    return './dashboard.html'
  }

  const redirectUrl = new URL(redirectTo, window.location.href)

  if (redirectUrl.origin !== window.location.origin) {
    return './dashboard.html'
  }

  return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
}

const redirectPath = getSafeRedirectPath()

const {
  data: { user }
} = await supabase.auth.getUser()

if (user) {
  window.location.replace(redirectPath)
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

  window.location.href = redirectPath
})
