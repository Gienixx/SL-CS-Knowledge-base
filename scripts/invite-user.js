import { supabase } from './supabaseClient.js'

const form = document.getElementById('inviteUserForm')
const message = document.getElementById('message')
const submitButton = document.getElementById('sendInviteButton')

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function setMessage(text, type = '') {
  message.textContent = text
  message.className = type
    ? `message ${type}`
    : 'message'
}

function setLoading(loading) {
  submitButton.disabled = loading
  submitButton.textContent = loading
    ? 'Sending Invite...'
    : 'Send Invite'
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

async function getAdminSession() {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession()

  if (sessionError) {
    throw sessionError
  }

  if (!session?.user || !session.access_token) {
    window.location.replace('./login.html')
    return null
  }

  const email = normalizeEmail(session.user.email)

  const {
    data: allowedUser,
    error: permissionError
  } = await supabase
    .from('login')
    .select('is_admin')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) {
    throw permissionError
  }

  if (allowedUser?.is_admin !== true) {
    window.location.replace('./dashboard.html')
    return null
  }

  return session
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

async function createApprovedUser(
  session,
  user
) {
  const response = await fetch('/create-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        `Bearer ${session.access_token}`
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

async function rollbackUser(
  session,
  createdUser,
  email
) {
  try {
    await fetch('/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        userId: createdUser?.id || '',
        email
      })
    })
  } catch (error) {
    console.error(
      'Unable to roll back user after email failure:',
      error
    )
  }
}

async function sendSetupEmail(email) {
  const redirectTo = new URL(
    './change-password.html?invite=1',
    window.location.href
  ).href

  const { error } =
    await supabase.auth.resetPasswordForEmail(
      email,
      { redirectTo }
    )

  if (error) {
    throw error
  }
}

async function initializeInvitePage() {
  let session

  try {
    session = await getAdminSession()
  } catch (error) {
    console.error(
      'Invite page access check failed:',
      error
    )
    setMessage(
      'Unable to verify administrator access.',
      'error'
    )
    return
  }

  if (!session) {
    return
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()

    const name =
      document.getElementById('name').value.trim()
    const email = normalizeEmail(
      document.getElementById('email').value
    )
    const isAdmin =
      document.getElementById('isAdmin').checked
    const canEditArticles =
      document.getElementById(
        'canEditArticles'
      ).checked

    if (!name || !email) {
      setMessage(
        'Enter the user name and email address.',
        'error'
      )
      return
    }

    setLoading(true)
    setMessage(
      'Creating the approved account and sending the setup email...'
    )

    let result

    try {
      result = await createApprovedUser(
        session,
        {
          name,
          email,
          password:
            createTemporaryCredential(),
          isAdmin,
          canEditArticles
        }
      )

      await sendSetupEmail(email)

      form.reset()
      setMessage(
        'Invitation email sent successfully.',
        'success'
      )
    } catch (error) {
      if (result?.user) {
        await rollbackUser(
          session,
          result.user,
          email
        )
      }

      console.error(
        'Invite user error:',
        error
      )
      setMessage(
        error.message ||
        'Unable to send the invitation.',
        'error'
      )
    } finally {
      setLoading(false)
    }
  })
}

initializeInvitePage()
