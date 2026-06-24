const supabase = window.__slSupabase

const form = document.getElementById('addUserForm')
const message = document.getElementById('message')
const openButton = document.getElementById('openAddUserModalButton')

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function createTemporaryCredential() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)

  const randomPart = Array.from(
    bytes,
    value => value.toString(16).padStart(2, '0')
  ).join('')

  return `Sl!${randomPart}aA1`
}

async function readJsonResponse(response) {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

async function getAdminSession() {
  if (!supabase) {
    throw new Error('The authentication client is unavailable.')
  }

  const {
    data: { session },
    error
  } = await supabase.auth.getSession()

  if (error) {
    throw error
  }

  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  return session
}

async function createApprovedUser(session, user) {
  const response = await fetch('/create-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify(user)
  })

  const result = await readJsonResponse(response)

  if (!response.ok) {
    throw new Error(
      result.error ||
      result.message ||
      'Unable to create the approved user.'
    )
  }

  return result
}

async function rollbackUser(session, createdUser, email) {
  try {
    await fetch('/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        userId: createdUser?.id || '',
        email
      })
    })
  } catch (error) {
    console.error(
      'Unable to roll back user after invitation failure:',
      error
    )
  }
}

async function sendSetupEmail(email) {
  const redirectTo = new URL(
    './change-password.html?invite=1',
    window.location.href
  ).href

  const { error } = await supabase.auth.resetPasswordForEmail(
    email,
    { redirectTo }
  )

  if (error) {
    throw error
  }
}

function setLoading(button, loading) {
  if (!button) {
    return
  }

  button.disabled = loading
  button.textContent = loading
    ? 'Sending Invite...'
    : 'Send Invite'
}

function updateInviteInterface() {
  if (!form) {
    return
  }

  if (openButton) {
    openButton.textContent = 'Invite User'
  }

  const pageDescription = document.querySelector('.admin-title p')
  if (pageDescription) {
    pageDescription.textContent =
      'Invite users, edit account information, and manage passwords for SocialLoop CS Base.'
  }

  const modalTitle = document.getElementById('addUserModalTitle')
  if (modalTitle) {
    modalTitle.textContent = 'Invite User'
  }

  const modalBackdrop = document.querySelector(
    '[data-close-modal="addUserModal"].admin-modal-backdrop'
  )
  if (modalBackdrop) {
    modalBackdrop.setAttribute(
      'aria-label',
      'Close invite user dialog'
    )
  }

  document.getElementById('password')?.remove()

  if (!document.getElementById('inviteUserNote')) {
    const note = document.createElement('p')
    note.id = 'inviteUserNote'
    note.className = 'admin-field-note'
    note.textContent =
      'The user will receive an email link to create their own password. No temporary password is shown or shared.'

    const actions = form.querySelector('.admin-modal-actions')
    actions?.insertAdjacentElement('beforebegin', note)
  }

  const submitButton = form.querySelector('button[type="submit"]')
  if (submitButton) {
    submitButton.textContent = 'Send Invite'
  }
}

function closeInviteModal() {
  const closeButton = document.querySelector(
    '#addUserModal [data-close-modal="addUserModal"]:not(.admin-modal-backdrop)'
  )

  closeButton?.click()
}

async function refreshUsers() {
  document.getElementById('refreshUsersButton')?.click()
}

async function handleInviteSubmit(event) {
  event.preventDefault()
  event.stopImmediatePropagation()

  const name = document.getElementById('name')?.value.trim() || ''
  const email = normalizeEmail(
    document.getElementById('email')?.value
  )
  const isAdmin =
    document.getElementById('isAdmin')?.checked === true
  const canEditArticles =
    document.getElementById('canEditArticles')?.checked === true
  const submitButton = form.querySelector('button[type="submit"]')

  if (!name || !email) {
    message.textContent = 'Enter the user name and email address.'
    return
  }

  setLoading(submitButton, true)
  message.textContent =
    'Creating the approved account and sending the invitation email...'

  let session
  let result

  try {
    session = await getAdminSession()
    result = await createApprovedUser(session, {
      name,
      email,
      password: createTemporaryCredential(),
      isAdmin,
      canEditArticles
    })

    await sendSetupEmail(email)

    form.reset()
    message.textContent = 'Invitation email sent successfully.'
    await refreshUsers()

    window.setTimeout(() => {
      closeInviteModal()
    }, 700)
  } catch (error) {
    if (session && result?.user) {
      await rollbackUser(session, result.user, email)
    }

    console.error('Invite user error:', error)
    message.textContent =
      `Unable to send invitation: ${error.message || 'An unexpected error occurred.'}`
  } finally {
    setLoading(submitButton, false)
  }
}

updateInviteInterface()

form?.addEventListener(
  'submit',
  handleInviteSubmit,
  { capture: true }
)
