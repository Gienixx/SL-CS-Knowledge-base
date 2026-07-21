import {
  supabase,
  requiresFirstLoginPasswordChange,
  sessionLifetimeReady
} from './supabaseClient.js'
import {
  evaluatePassword,
  passwordsMatch
} from './password-policy.js?v=1'

const form = document.getElementById('changePasswordForm')
const message = document.getElementById('message')
const newPasswordInput = document.getElementById('newPassword')
const confirmPasswordInput = document.getElementById('confirmPassword')
const submitButton = document.getElementById('updatePasswordButton')
const backToHome = document.getElementById('backToHome')
const firstLoginNotice = document.getElementById('firstLoginNotice')
const pageTitle = document.getElementById('pageTitle')
const pageDescription = document.getElementById('pageDescription')
const passwordVisibilityButton = document.getElementById('passwordVisibilityButton')
const eyeOpenIcon = document.getElementById('eyeOpenIcon')
const eyeClosedIcon = document.getElementById('eyeClosedIcon')
const strengthSegments = [1, 2, 3].map(index =>
  document.getElementById(`strengthSegment${index}`)
)
const strengthLabel = document.getElementById('strengthLabel')
const lengthRequirement = document.getElementById('lengthRequirement')
const caseRequirement = document.getElementById('caseRequirement')
const numberRequirement = document.getElementById('numberRequirement')
const matchIcon = document.getElementById('matchIcon')
const matchLabel = document.getElementById('matchLabel')
const isInvitation = new URLSearchParams(window.location.search).get('invite') === '1'
const isPasswordReset = new URLSearchParams(window.location.search).get('reset') === '1'

function setMessage(text, type = '') {
  message.textContent = text
  message.className = type ? `message ${type}` : 'message'
}

function setRequirement(element, met) {
  element.classList.toggle('met', met)
  element.querySelector('.requirement-icon').textContent = met ? '✓' : '○'
}

function updatePasswordMatch() {
  const confirmation = confirmPasswordInput.value

  if (!confirmation) {
    matchIcon.textContent = ''
    matchLabel.textContent = ''
    matchLabel.style.color = ''
    return
  }

  const matches = passwordsMatch(newPasswordInput.value, confirmation)
  matchIcon.textContent = matches ? '✓' : '!'
  matchIcon.style.color = matches ? 'var(--success)' : 'var(--danger)'
  matchLabel.textContent = matches
    ? 'Passwords match'
    : "Passwords don't match yet"
  matchLabel.style.color = matches ? 'var(--success)' : 'var(--danger)'
}

function updatePasswordStrength() {
  const value = newPasswordInput.value
  const { checks, score, label } = evaluatePassword(value)
  const colors = ['var(--danger)', 'var(--warning)', 'var(--success)']

  setRequirement(lengthRequirement, checks.hasLength)
  setRequirement(caseRequirement, checks.hasMixedCase)
  setRequirement(numberRequirement, checks.hasNumber)

  strengthSegments.forEach((segment, index) => {
    segment.style.background = value && index < score
      ? colors[Math.max(score - 1, 0)]
      : 'var(--border)'
  })

  strengthLabel.textContent = label
  strengthLabel.style.color = !value
    ? 'var(--text-muted)'
    : score <= 1 ? 'var(--danger)' : score === 2 ? 'var(--warning)' : 'var(--success)'

  updatePasswordMatch()
}

passwordVisibilityButton.addEventListener('click', () => {
  const showing = newPasswordInput.type === 'text'
  newPasswordInput.type = showing ? 'password' : 'text'
  eyeOpenIcon.hidden = !showing
  eyeClosedIcon.hidden = showing
  passwordVisibilityButton.setAttribute('aria-pressed', String(!showing))
  passwordVisibilityButton.setAttribute('aria-label', showing ? 'Show password' : 'Hide password')
})

newPasswordInput.addEventListener('input', updatePasswordStrength)
confirmPasswordInput.addEventListener('input', updatePasswordMatch)

await sessionLifetimeReady
const { data: { user }, error: userError } = await supabase.auth.getUser()

if (userError || !user) {
  window.location.replace('./login.html')
} else {
  const isAccountSetup = !isPasswordReset &&
    (isInvitation || requiresFirstLoginPasswordChange(user))

  if (isPasswordReset) {
    backToHome.href = './login.html'
    backToHome.textContent = 'Back to sign in'
    firstLoginNotice.hidden = false
    firstLoginNotice.textContent =
      "We've verified your identity. Choose a new password for your account."
    pageTitle.textContent = 'Reset your password'
    pageDescription.textContent = 'Choose a new password that you will use to sign in.'
    submitButton.textContent = 'Reset password'
  }

  if (isAccountSetup) {
    backToHome.href = './login.html'
    backToHome.textContent = 'Back to sign in'
    firstLoginNotice.hidden = false
    firstLoginNotice.textContent =
      'You accepted your invitation. Create a password to finish setting up your account.'
    pageTitle.textContent = 'Create your password'
    pageDescription.textContent =
      'Choose a secure password that you will use to sign in.'
    submitButton.textContent = 'Create password'
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()

    const passwordEvaluation = evaluatePassword(newPasswordInput.value)
    if (!passwordEvaluation.valid) {
      setMessage('Use at least 8 characters with upper and lowercase letters and a number.', 'error')
      newPasswordInput.focus()
      return
    }

    if (!passwordsMatch(newPasswordInput.value, confirmPasswordInput.value)) {
      setMessage("Passwords don't match yet.", 'error')
      confirmPasswordInput.focus()
      return
    }

    submitButton.disabled = true
    submitButton.textContent = isAccountSetup
      ? 'Creating password...'
      : isPasswordReset ? 'Resetting password...' : 'Updating password...'
    setMessage(isAccountSetup
      ? 'Creating your password...'
      : isPasswordReset ? 'Resetting your password...' : 'Updating your password...')

    const currentMetadata = user.user_metadata &&
      typeof user.user_metadata === 'object'
      ? user.user_metadata
      : {}

    const { error } = await supabase.auth.updateUser({
      password: newPasswordInput.value,
      data: {
        ...currentMetadata,
        password_change_completed: true,
        password_changed_at: new Date().toISOString()
      }
    })

    if (error) {
      setMessage(error.message, 'error')
      submitButton.disabled = false
      submitButton.textContent = isAccountSetup
        ? 'Create password'
        : isPasswordReset ? 'Reset password' : 'Update password'
      return
    }

    form.reset()
    updatePasswordStrength()
    setMessage(
      isAccountSetup
        ? 'Password created. Your account is ready.'
        : isPasswordReset ? 'Password reset successfully. Redirecting to login...' : 'Password updated successfully.',
      'success'
    )

    if (isAccountSetup) {
      window.setTimeout(() => window.location.replace('./home.html'), 700)
    } else if (isPasswordReset) {
      await supabase.auth.signOut()
      window.setTimeout(() => window.location.replace('./login.html'), 700)
    } else {
      submitButton.disabled = false
      submitButton.textContent = 'Update password'
    }
  })
}
