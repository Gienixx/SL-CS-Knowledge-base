import { supabase } from './supabaseClient.js?v=9'

const tableBody = document.getElementById('usersTableBody')
const usersMessage = document.getElementById('usersMessage')
const refreshButton = document.getElementById('refreshUsersButton')
const openInviteButton = document.getElementById('openInviteButton')
const editButton = document.getElementById('editUserButton')
const deleteButton = document.getElementById('deleteUserButton')

const inviteForm = document.getElementById('inviteUserForm')
const inviteMessage = document.getElementById('inviteMessage')
const sendInviteButton = document.getElementById('sendInviteButton')

const editForm = document.getElementById('editUserForm')
const editMessage = document.getElementById('editMessage')
const deleteMessage = document.getElementById('deleteMessage')
const confirmDeleteButton = document.getElementById('confirmDeleteButton')

const changePasswordForm = document.getElementById('changePasswordForm')
const changePasswordMessage = document.getElementById('changePasswordMessage')

let users = []
let selectedKey = ''
let originalEditEmail = ''
let currentSession = null
let lastFocusedElement = null

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function userKey(user) {
  return user?.user_id || normalizeEmail(user?.email)
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  if (!element) return
  element.textContent = text
  element.className = type
    ? `um-message ${type}`
    : 'um-message'
}

function setLoading(button, loading, loadingText, readyText) {
  if (!button) return
  button.disabled = loading
  button.textContent = loading ? loadingText : readyText
}

function openModal(id, focusElement) {
  const modal = document.getElementById(id)
  if (!modal) return

  lastFocusedElement = document.activeElement
  modal.hidden = false
  document.body.classList.add('modal-open')

  requestAnimationFrame(() => focusElement?.focus())
}

function closeModal(id) {
  const modal = document.getElementById(id)
  if (!modal) return

  modal.hidden = true

  const anyOpen = [...document.querySelectorAll('.um-modal')]
    .some(item => !item.hidden)

  if (!anyOpen) {
    document.body.classList.remove('modal-open')
  }

  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus()
  }
}

function initializeModalControls() {
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      closeModal(button.dataset.close)
    })
  })

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return

    const openModalElement = [...document.querySelectorAll('.um-modal')]
      .find(modal => !modal.hidden)

    if (openModalElement) {
      closeModal(openModalElement.id)
    }
  })
}

async function requireAdmin() {
  const {
    data: { session },
    error
  } = await supabase.auth.getSession()

  if (error) throw error

  if (!session?.user || !session.access_token) {
    window.location.replace('./login.html')
    return null
  }

  const email = normalizeEmail(session.user.email)
  const { data, error: permissionError } = await supabase
    .from('login')
    .select('is_admin')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) throw permissionError

  if (data?.is_admin !== true) {
    window.location.replace('./dashboard.html')
    return null
  }

  return session
}

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

async function request(endpoint, options = {}) {
  const session = currentSession || await requireAdmin()

  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  const response = await fetch(endpoint, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${session.access_token}`,
      ...(options.headers || {})
    }
  })

  const result = await parseResponse(response)

  if (!response.ok) {
    throw new Error(
      result.error ||
      result.message ||
      `Request failed with status ${response.status}.`
    )
  }

  return result
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

function selectedUser() {
  return users.find(user => userKey(user) === selectedKey) || null
}

function updateSelectionControls() {
  const hasSelection = Boolean(selectedKey)
  editButton.disabled = !hasSelection
  deleteButton.disabled = !hasSelection
}

function clearSelection() {
  selectedKey = ''
  document.querySelectorAll('.um-select').forEach(checkbox => {
    checkbox.checked = false
    checkbox.closest('tr')?.classList.remove('selected')
  })
  updateSelectionControls()
}

function selectRow(checkbox, key) {
  document.querySelectorAll('.um-select').forEach(item => {
    const current = item === checkbox
    item.checked = current && checkbox.checked
    item.closest('tr')?.classList.toggle(
      'selected',
      current && checkbox.checked
    )
  })

  selectedKey = checkbox.checked ? key : ''
  updateSelectionControls()
}

function textCell(value, className = '') {
  const cell = document.createElement('td')
  cell.textContent = value || '—'
  if (className) cell.className = className
  return cell
}

function statusCell(enabled) {
  const cell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `um-status ${enabled ? 'yes' : 'no'}`
  badge.textContent = enabled ? 'Yes' : 'No'
  cell.appendChild(badge)
  return cell
}

function renderUsers() {
  tableBody.replaceChildren()

  if (!users.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 6
    cell.className = 'um-empty'
    cell.textContent = 'No users were found.'
    row.appendChild(cell)
    tableBody.appendChild(row)
    clearSelection()
    return
  }

  if (!users.some(user => userKey(user) === selectedKey)) {
    selectedKey = ''
  }

  users.forEach(user => {
    const row = document.createElement('tr')
    const key = userKey(user)
    const selected = key === selectedKey
    row.classList.toggle('selected', selected)

    const selectCell = document.createElement('td')
    selectCell.className = 'um-select-cell'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'um-select'
    checkbox.checked = selected
    checkbox.setAttribute(
      'aria-label',
      `Select ${user.name || user.email}`
    )
    checkbox.addEventListener('change', () => selectRow(checkbox, key))
    selectCell.appendChild(checkbox)

    row.append(
      selectCell,
      textCell(user.user_id, 'um-id'),
      textCell(user.name),
      textCell(user.email),
      statusCell(user.is_admin === true),
      statusCell(user.can_edit_articles === true)
    )

    tableBody.appendChild(row)
  })

  updateSelectionControls()
}

async function loadUsers() {
  setLoading(refreshButton, true, 'Refreshing...', 'Refresh')
  setMessage(usersMessage, 'Loading users...')

  try {
    const result = await request('/list-users', { method: 'GET' })
    users = Array.isArray(result.users) ? result.users : []
    renderUsers()
    setMessage(
      usersMessage,
      `${users.length} user${users.length === 1 ? '' : 's'} found.`
    )
  } catch (error) {
    users = []
    renderUsers()
    setMessage(usersMessage, errorMessage(error), 'error')
  } finally {
    setLoading(refreshButton, false, 'Refreshing...', 'Refresh')
  }
}

async function rollbackCreatedUser(createdUser, email) {
  try {
    await request('/delete-user', {
      method: 'POST',
      body: JSON.stringify({
        userId: createdUser?.id || '',
        email
      })
    })
  } catch (error) {
    console.error('Invite rollback failed:', error)
  }
}

async function sendInvitationEmail(email) {
  const redirectTo = new URL(
    './change-password.html?invite=1',
    window.location.href
  ).href

  const { error } = await supabase.auth.resetPasswordForEmail(
    email,
    { redirectTo }
  )

  if (error) throw error
}

function initializeInvitation() {
  openInviteButton.addEventListener('click', () => {
    inviteForm.reset()
    setMessage(inviteMessage, '')
    openModal('inviteModal', document.getElementById('inviteName'))
  })

  inviteForm.addEventListener('submit', async event => {
    event.preventDefault()

    const name = document.getElementById('inviteName').value.trim()
    const email = normalizeEmail(
      document.getElementById('inviteEmail').value
    )
    const isAdmin = document.getElementById('inviteIsAdmin').checked
    const canEditArticles = document.getElementById('inviteCanEdit').checked

    if (!name || !email) {
      setMessage(inviteMessage, 'Enter the user name and email address.', 'error')
      return
    }

    setLoading(sendInviteButton, true, 'Sending Invite...', 'Send Invite')
    setMessage(
      inviteMessage,
      'Creating the approved account and sending the invitation email...'
    )

    let result

    try {
      result = await request('/create-user', {
        method: 'POST',
        body: JSON.stringify({
          name,
          email,
          password: createTemporaryCredential(),
          isAdmin,
          canEditArticles
        })
      })

      await sendInvitationEmail(email)
      inviteForm.reset()
      setMessage(inviteMessage, 'Invitation email sent successfully.', 'success')
      clearSelection()
      await loadUsers()
      window.setTimeout(() => closeModal('inviteModal'), 700)
    } catch (error) {
      if (result?.user) {
        await rollbackCreatedUser(result.user, email)
      }
      setMessage(
        inviteMessage,
        `Unable to send invitation: ${errorMessage(error)}`,
        'error'
      )
    } finally {
      setLoading(sendInviteButton, false, 'Sending Invite...', 'Send Invite')
    }
  })
}

function initializeEdit() {
  editButton.addEventListener('click', () => {
    const user = selectedUser()

    if (!user) {
      clearSelection()
      setMessage(usersMessage, 'Select a user before clicking Edit.', 'error')
      return
    }

    originalEditEmail = normalizeEmail(user.email)
    document.getElementById('editUserId').value = user.user_id || ''
    document.getElementById('editName').value = user.name || ''
    document.getElementById('editEmail').value = originalEditEmail
    document.getElementById('editIsAdmin').checked = user.is_admin === true
    document.getElementById('editCanEdit').checked = user.can_edit_articles === true
    setMessage(editMessage, '')
    openModal('editModal', document.getElementById('editName'))
  })

  editForm.addEventListener('submit', async event => {
    event.preventDefault()

    const submitButton = editForm.querySelector('button[type="submit"]')
    const userId = document.getElementById('editUserId').value.trim()
    const name = document.getElementById('editName').value.trim()
    const email = normalizeEmail(document.getElementById('editEmail').value)
    const isAdmin = document.getElementById('editIsAdmin').checked
    const canEditArticles = document.getElementById('editCanEdit').checked

    if (!name || !email || !originalEditEmail) {
      setMessage(editMessage, 'Enter the user name and email address.', 'error')
      return
    }

    setLoading(submitButton, true, 'Saving...', 'Save Changes')
    setMessage(editMessage, 'Saving user changes...')

    try {
      await request('/user-settings', {
        method: 'POST',
        body: JSON.stringify({
          action: 'update',
          userId,
          originalEmail: originalEditEmail,
          name,
          email,
          isAdmin,
          canEditArticles
        })
      })

      selectedKey = userId || email
      originalEditEmail = email
      await loadUsers()
      setMessage(editMessage, 'User updated successfully.', 'success')
      window.setTimeout(() => closeModal('editModal'), 600)
    } catch (error) {
      setMessage(editMessage, `Unable to update user: ${errorMessage(error)}`, 'error')
    } finally {
      setLoading(submitButton, false, 'Saving...', 'Save Changes')
    }
  })
}

function initializeDelete() {
  deleteButton.addEventListener('click', () => {
    const user = selectedUser()

    if (!user) {
      clearSelection()
      setMessage(usersMessage, 'Select a user before clicking Delete.', 'error')
      return
    }

    document.getElementById('deleteSummary').textContent =
      `Delete ${user.name || 'this user'} — ${user.email}?`
    setMessage(deleteMessage, '')
    openModal('deleteModal', confirmDeleteButton)
  })

  confirmDeleteButton.addEventListener('click', async () => {
    const user = selectedUser()

    if (!user) {
      setMessage(deleteMessage, 'The selected user is no longer available.', 'error')
      return
    }

    setLoading(confirmDeleteButton, true, 'Deleting...', 'Delete User')
    setMessage(deleteMessage, 'Deleting user...')

    try {
      await request('/delete-user', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.user_id || '',
          email: normalizeEmail(user.email)
        })
      })

      clearSelection()
      closeModal('deleteModal')
      await loadUsers()
      setMessage(usersMessage, 'User deleted successfully.', 'success')
    } catch (error) {
      setMessage(deleteMessage, `Unable to delete user: ${errorMessage(error)}`, 'error')
    } finally {
      setLoading(confirmDeleteButton, false, 'Deleting...', 'Delete User')
    }
  })
}

function initializePasswordChange() {
  changePasswordForm.addEventListener('submit', async event => {
    event.preventDefault()

    const email = normalizeEmail(
      document.getElementById('changeEmail').value
    )
    const password = document.getElementById('newPassword').value
    const submitButton = changePasswordForm.querySelector('button')

    if (!email || password.length < 8) {
      setMessage(
        changePasswordMessage,
        'Enter a valid email and a password with at least 8 characters.',
        'error'
      )
      return
    }

    setLoading(submitButton, true, 'Updating...', 'Change Password')
    setMessage(changePasswordMessage, 'Updating password...')

    try {
      await request('/change-password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      })
      changePasswordForm.reset()
      setMessage(changePasswordMessage, 'Password changed successfully.', 'success')
    } catch (error) {
      setMessage(
        changePasswordMessage,
        `Unable to change password: ${errorMessage(error)}`,
        'error'
      )
    } finally {
      setLoading(submitButton, false, 'Updating...', 'Change Password')
    }
  })
}

async function initialize() {
  try {
    currentSession = await requireAdmin()
    if (!currentSession) return

    initializeModalControls()
    initializeInvitation()
    initializeEdit()
    initializeDelete()
    initializePasswordChange()
    refreshButton.addEventListener('click', loadUsers)
    await loadUsers()
  } catch (error) {
    console.error('User management initialization failed:', error)
    alert('Unable to verify administrator access.')
    window.location.replace('./dashboard.html')
  }
}

initialize()
