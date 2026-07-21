import {
  supabase,
  requiresFirstLoginPasswordChange,
  sessionLifetimeReady,
  startSessionLifetime
} from './supabaseClient.js'

const loginForm = document.getElementById('loginForm')
const loginStatus = document.getElementById('loginStatus')
const submitButton = loginForm?.querySelector('button[type="submit"]')
const forgotPasswordButton = document.getElementById('forgotPasswordButton')
const forgotPasswordModal = document.getElementById('forgotPasswordModal')
const resetPasswordForm = document.getElementById('resetPasswordForm')
const resetEmail = document.getElementById('resetEmail')
const resetStatus = document.getElementById('resetStatus')
const sendResetLink = document.getElementById('sendResetLink')
const closeResetModalButton = document.getElementById('closeResetModal')
const cancelResetButton = document.getElementById('cancelReset')
let resetRequestCompleted = false

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

  return './home.html'
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

function setResetStatus(text, type = '') {
  resetStatus.textContent = text
  resetStatus.className = type ? `status ${type}` : 'status'
}

function openResetModal() {
  resetPasswordForm.reset()
  resetRequestCompleted = false
  setResetStatus('')
  resetEmail.value = document.getElementById('email').value.trim()
  forgotPasswordModal.hidden = false
  document.body.classList.add('modal-open')
  window.setTimeout(() => resetEmail.focus(), 0)
}

function closeResetModal() {
  forgotPasswordModal.hidden = true
  document.body.classList.remove('modal-open')
  forgotPasswordButton.focus()
}

forgotPasswordButton?.addEventListener('click', openResetModal)
closeResetModalButton?.addEventListener('click', closeResetModal)
cancelResetButton?.addEventListener('click', closeResetModal)

forgotPasswordModal?.addEventListener('click', event => {
  if (event.target === forgotPasswordModal) closeResetModal()
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !forgotPasswordModal?.hidden) closeResetModal()
})

resetPasswordForm?.addEventListener('submit', async event => {
  event.preventDefault()

  if (resetRequestCompleted) {
    closeResetModal()
    return
  }

  sendResetLink.disabled = true
  sendResetLink.textContent = 'Sending...'
  setResetStatus('Requesting a secure reset link...')

  const redirectUrl = new URL('./change-password.html?reset=1', window.location.href)
  const { error } = await supabase.auth.resetPasswordForEmail(
    resetEmail.value.trim(),
    { redirectTo: redirectUrl.href }
  )

  if (error) {
    setResetStatus(error.message || 'Unable to send the reset link. Please try again.', 'error')
    sendResetLink.disabled = false
    sendResetLink.textContent = 'Send reset link'
    return
  }

  resetRequestCompleted = true
  setResetStatus('If an account exists for that email, a password reset link has been sent.', 'success')
  sendResetLink.disabled = false
  sendResetLink.textContent = 'Done'
})

async function initializeLogin() {
  await sessionLifetimeReady

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

  if (new URLSearchParams(window.location.search).get('sessionExpired') === '1') {
    loginStatus.textContent = 'Your session expired. Please sign in again.'
    loginStatus.className = 'status error'
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

      startSessionLifetime(data.session)

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
