import {
  supabase,
  requiresFirstLoginPasswordChange
} from './supabaseClient.js'

const form = document.getElementById('changePasswordForm')
const message = document.getElementById('message')
const newPasswordInput = document.getElementById('newPassword')
const confirmPasswordInput = document.getElementById('confirmPassword')
const backToHome = document.getElementById('backToHome')
const firstLoginNotice = document.getElementById('firstLoginNotice')
const pageTitle = document.getElementById('pageTitle')
const pageDescription = document.getElementById('pageDescription')

function setMessage(text, type = '') {
  if (!message) {
    return
  }

  message.textContent = text
  message.className = type
    ? `message ${type}`
    : 'message'
}

async function initializeFirstLoginFlow() {
  const {
    data: { user }
  } = await supabase.auth.getUser()

  if (!user) {
    return
  }

  const firstLoginRequired =
    requiresFirstLoginPasswordChange(user)

  if (firstLoginRequired) {
    backToHome.hidden = true
    firstLoginNotice.hidden = false
    pageTitle.textContent = 'Create a New Password'
    pageDescription.textContent =
      'Replace the temporary password provided by your administrator to continue.'
  }

  form?.addEventListener(
    'submit',
    event => {
      if (
        newPasswordInput.value !==
        confirmPasswordInput.value
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setMessage('The passwords do not match.', 'error')
      }
    },
    true
  )

  if (!firstLoginRequired || !message) {
    return
  }

  let completingSetup = false

  const observer = new MutationObserver(async () => {
    if (
      completingSetup ||
      message.textContent.trim() !==
        'Password updated successfully'
    ) {
      return
    }

    completingSetup = true
    setMessage('Password updated. Completing account setup...')

    const currentMetadata =
      user.user_metadata &&
      typeof user.user_metadata === 'object'
        ? user.user_metadata
        : {}

    const { error } = await supabase.auth.updateUser({
      data: {
        ...currentMetadata,
        password_change_completed: true,
        password_changed_at: new Date().toISOString()
      }
    })

    if (error) {
      completingSetup = false
      setMessage(
        'Your password was changed, but account setup could not be completed. Please try again.',
        'error'
      )
      return
    }

    setMessage('Password updated successfully.', 'success')

    window.setTimeout(() => {
      window.location.replace('./home.html')
    }, 700)
  })

  observer.observe(message, {
    childList: true,
    subtree: true,
    characterData: true
  })
}

initializeFirstLoginFlow()
