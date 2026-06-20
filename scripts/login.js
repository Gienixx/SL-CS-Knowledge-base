import { supabase } from './supabaseClient.js'

const loginForm = document.getElementById('loginForm')
const loginStatus = document.getElementById('loginStatus')
const submitButton = loginForm?.querySelector('button[type="submit"]')

const FIRST_LOGIN_POLICY_START = Date.parse(
  '2026-06-21T00:00:00.000Z'
)

function getReturnPage() {
  const params = new URLSearchParams(window.location.search)
  const returnTo = params.get('returnTo')

  if (
    returnTo &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//')
  ) {
    return returnTo
  }

  return './dashboard.html'
}

function requiresFirstLoginPasswordChange(user) {
  if (!user) {
    return false
  }

  if (
    user.user_metadata
      ?.password_change_completed === true
  ) {
    return false
  }

  const createdAt = Date.parse(user.created_at || '')

  return (
    Number.isFinite(createdAt) &&
    createdAt >= FIRST_LOGIN_POLICY_START
  )
}

function getDestination(user) {
  if (requiresFirstLoginPasswordChange(user)) {
    return './change-password.html?firstLogin=1'
  }

  return getReturnPage()
}

function setLoading(loading) {
  if (!submitButton) {
    return
  }

  submitButton.disabled = loading
  submitButton.textContent = loading
    ? 'Signing In...'
    : 'Sign In'
}

async function initializeLogin() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    console.warn('Unable to read current session:', userError)
  }

  if (user) {
    window.location.replace(getDestination(user))
    return
  }

  loginForm?.addEventListener('submit', async event => {
    event.preventDefault()

    const email = document
      .getElementById('email')
      .value
      .trim()

    const password = document
      .getElementById('password')
      .value

    loginStatus.textContent = 'Signing in...'
    loginStatus.className = 'status'
    setLoading(true)

    try {
      const {
        data,
        error
      } = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) {
        throw error
      }

      loginStatus.textContent =
        requiresFirstLoginPasswordChange(data.user)
          ? 'First login detected. Redirecting to password setup...'
          : 'Login successful. Redirecting...'

      loginStatus.className = 'status success'
      window.location.replace(getDestination(data.user))
    } catch (error) {
      loginStatus.textContent =
        error.message || 'Unable to sign in.'

      loginStatus.className = 'status error'
      setLoading(false)
    }
  })
}

initializeLogin()
