import { supabase } from './supabaseClient.js'

const addUserForm = document.getElementById('addUserForm')
const addUserMessage = document.getElementById('message')
const changePasswordForm = document.getElementById('changePasswordForm')
const changePasswordMessage = document.getElementById('changePasswordMessage')
const usersTableBody = document.getElementById('usersTableBody')
const usersTableMessage = document.getElementById('usersTableMessage')
const refreshUsersButton = document.getElementById('refreshUsersButton')
const openAddUserModalButton = document.getElementById('openAddUserModalButton')
const editSelectedUserButton = document.getElementById('editSelectedUserButton')
const deleteSelectedUserButton = document.getElementById('deleteSelectedUserButton')
const editSelectedUserForm = document.getElementById('editSelectedUserForm')
const editSelectedUserMessage = document.getElementById('editSelectedUserMessage')
const editUserId = document.getElementById('editUserId')
const editUserName = document.getElementById('editUserName')
const editUserAccountEmail = document.getElementById('editUserAccountEmail')
const editUserIsAdmin = document.getElementById('editUserIsAdmin')
const editUserCanEditArticles = document.getElementById('editUserCanEditArticles')
const deleteUserSummary = document.getElementById('deleteUserSummary')
const deleteUserMessage = document.getElementById('deleteUserMessage')
const confirmDeleteUserButton = document.getElementById('confirmDeleteUserButton')
const cancelDeleteUserButton = document.getElementById('cancelDeleteUserButton')

let usersCache = []
let selectedUserKey = ''
let editOriginalEmail = ''
let lastFocusedElement = null

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function getUserKey(user) {
  return user?.user_id || normalizeEmail(user?.email)
}

function getErrorMessage(error) {
  return error && typeof error.message === 'string'
    ? error.message
    : 'An unexpected error occurred.'
}

function redirectToLogin() {
  window.location.replace('./login.html')
}

function redirectToDashboard() {
  window.location.replace('./dashboard.html')
}

async function requireAdminAccess() {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession()

  if (sessionError) {
    throw sessionError
  }

  if (!session?.user) {
    redirectToLogin()
    return null
  }

  const email = normalizeEmail(session.user.email)

  if (!email) {
    redirectToLogin()
    return null
  }

  const { data: allowedUser, error: permissionError } = await supabase
    .from('login')
    .select('is_admin')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) {
    throw permissionError
  }

  if (!allowedUser || allowedUser.is_admin !== true) {
    alert('Admin access only.')
    redirectToDashboard()
    return null
  }

  return session
}

async function getAccessToken() {
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

  return session.access_token
}

async function parseResponse(response) {
  const responseText = await response.text()

  if (!responseText) {
    return {}
  }

  try {
    return JSON.parse(responseText)
  } catch {
    return { error: responseText }
  }
}

async function sendAdminRequest(endpoint, payload) {
  const accessToken = await getAccessToken()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
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

async function sendAdminGetRequest(endpoint) {
  const accessToken = await getAccessToken()
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
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

function setButtonLoading(button, loading, loadingText, normalText) {
  if (!button) {
    return
  }

  button.disabled = loading
  button.textContent = loading ? loadingText : normalText
}

function openModal(modalId, focusElement) {
  const modal = document.getElementById(modalId)

  if (!modal) {
    return
  }

  lastFocusedElement = document.activeElement
  modal.hidden = false
  document.body.classList.add('admin-modal-open')

  window.requestAnimationFrame(() => {
    focusElement?.focus()
  })
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId)

  if (!modal) {
    return
  }

  modal.hidden = true

  const anyOpenModal = Array.from(
    document.querySelectorAll('.admin-modal')
  ).some(item => !item.hidden)

  if (!anyOpenModal) {
    document.body.classList.remove('admin-modal-open')
  }

  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus()
  }
}

function initializeModalControls() {
  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => {
      closeModal(button.dataset.closeModal)
    })
  })

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') {
      return
    }

    const openModalElement = Array.from(
      document.querySelectorAll('.admin-modal')
    ).find(modal => !modal.hidden)

    if (openModalElement) {
      closeModal(openModalElement.id)
    }
  })
}

function createUsersTableCell(value, className = '') {
  const cell = document.createElement('td')
  cell.textContent = value === null || value === undefined || value === ''
    ? '—'
    : String(value)

  if (className) {
    cell.className = className
  }

  return cell
}

function createPermissionCell(enabled) {
  const cell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = enabled
    ? 'user-status user-status-yes'
    : 'user-status user-status-no'
  badge.textContent = enabled ? 'Yes' : 'No'
  cell.appendChild(badge)
  return cell
}

function updateSelectionButtonState() {
  const hasSelectedUser = Boolean(selectedUserKey)

  if (editSelectedUserButton) {
    editSelectedUserButton.disabled = !hasSelectedUser
  }

  if (deleteSelectedUserButton) {
    deleteSelectedUserButton.disabled = !hasSelectedUser
  }
}

function clearSelectedUser() {
  selectedUserKey = ''
  updateSelectionButtonState()

  document.querySelectorAll('.user-row-checkbox').forEach(checkbox => {
    checkbox.checked = false
    checkbox.closest('tr')?.classList.remove('is-selected')
  })
}

function selectUserCheckbox(checkbox, userKey) {
  document.querySelectorAll('.user-row-checkbox').forEach(otherCheckbox => {
    const isCurrent = otherCheckbox === checkbox
    otherCheckbox.checked = isCurrent && checkbox.checked
    otherCheckbox.closest('tr')?.classList.toggle(
      'is-selected',
      isCurrent && checkbox.checked
    )
  })

  selectedUserKey = checkbox.checked ? userKey : ''
  updateSelectionButtonState()
}

function createSelectionCell(user) {
  const cell = document.createElement('td')
  cell.className = 'users-table-select'

  const checkbox = document.createElement('input')
  const userKey = getUserKey(user)
  checkbox.type = 'checkbox'
  checkbox.className = 'user-row-checkbox'
  checkbox.checked = selectedUserKey === userKey
  checkbox.setAttribute('aria-label', `Select ${user.name || user.email}`)

  checkbox.addEventListener('change', () => {
    selectUserCheckbox(checkbox, userKey)
  })

  cell.appendChild(checkbox)
  return cell
}

function showUsersTableMessage(message) {
  if (!usersTableBody) {
    return
  }

  usersTableBody.innerHTML = ''
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = 6
  cell.className = 'users-table-empty'
  cell.textContent = message
  row.appendChild(cell)
  usersTableBody.appendChild(row)
}

function renderUsers(users) {
  if (!usersTableBody) {
    return
  }

  usersTableBody.innerHTML = ''

  if (!Array.isArray(users) || users.length === 0) {
    clearSelectedUser()
    showUsersTableMessage('No users were found.')
    return
  }

  const selectionStillExists = users.some(
    user => getUserKey(user) === selectedUserKey
  )

  if (!selectionStillExists) {
    selectedUserKey = ''
  }

  users.forEach(user => {
    const row = document.createElement('tr')
    const isSelected = getUserKey(user) === selectedUserKey

    row.classList.toggle('is-selected', isSelected)
    row.appendChild(createSelectionCell(user))
    row.appendChild(createUsersTableCell(user.user_id, 'users-table-id'))
    row.appendChild(createUsersTableCell(user.name))
    row.appendChild(createUsersTableCell(user.email))
    row.appendChild(createPermissionCell(user.is_admin === true))
    row.appendChild(createPermissionCell(user.can_edit_articles === true))
    usersTableBody.appendChild(row)
  })

  updateSelectionButtonState()
}

async function loadUsers() {
  if (!usersTableBody || !usersTableMessage) {
    return
  }

  showUsersTableMessage('Loading users...')
  usersTableMessage.textContent = ''
  setButtonLoading(refreshUsersButton, true, 'Refreshing...', 'Refresh')

  try {
    const result = await sendAdminGetRequest('/list-users')
    usersCache = Array.isArray(result.users) ? result.users : []
    renderUsers(usersCache)
    usersTableMessage.textContent = `${usersCache.length} user${usersCache.length === 1 ? '' : 's'} found.`
  } catch (error) {
    console.error('Load users error:', error)
    usersCache = []
    clearSelectedUser()
    showUsersTableMessage('Unable to load users.')
    usersTableMessage.textContent = getErrorMessage(error)
  } finally {
    setButtonLoading(refreshUsersButton, false, 'Refreshing...', 'Refresh')
  }
}

function initializeAddUserForm() {
  if (!addUserForm || !addUserMessage) {
    return
  }

  openAddUserModalButton?.addEventListener('click', () => {
    addUserMessage.textContent = ''
    openModal('addUserModal', document.getElementById('name'))
  })

  addUserForm.addEventListener('submit', async event => {
    event.preventDefault()

    const nameInput = document.getElementById('name')
    const emailInput = document.getElementById('email')
    const passwordInput = document.getElementById('password')
    const isAdminInput = document.getElementById('isAdmin')
    const canEditArticlesInput = document.getElementById('canEditArticles')
    const submitButton = addUserForm.querySelector('button[type="submit"]')

    const name = nameInput?.value.trim() ?? ''
    const email = normalizeEmail(emailInput?.value)
    const password = passwordInput?.value ?? ''
    const isAdmin = isAdminInput?.checked === true
    const canEditArticles = canEditArticlesInput?.checked === true

    if (!name || !email || !password) {
      addUserMessage.textContent = 'Enter the user name, email address, and temporary password.'
      return
    }

    if (password.length < 8) {
      addUserMessage.textContent = 'The temporary password must contain at least 8 characters.'
      return
    }

    setButtonLoading(submitButton, true, 'Adding User...', 'Add User')
    addUserMessage.textContent = 'Creating user...'

    try {
      await sendAdminRequest('/create-user', {
        name,
        email,
        password,
        isAdmin,
        canEditArticles
      })

      addUserForm.reset()
      addUserMessage.textContent = 'User created successfully.'
      clearSelectedUser()
      await loadUsers()
      window.setTimeout(() => closeModal('addUserModal'), 500)
    } catch (error) {
      console.error('Create-user error:', error)
      addUserMessage.textContent = `Unable to create user: ${getErrorMessage(error)}`
    } finally {
      setButtonLoading(submitButton, false, 'Adding User...', 'Add User')
    }
  })
}

function getSelectedUser() {
  return usersCache.find(user => getUserKey(user) === selectedUserKey) || null
}

function initializeEditUserModal() {
  if (
    !editSelectedUserButton ||
    !editSelectedUserForm ||
    !editSelectedUserMessage ||
    !editUserId ||
    !editUserName ||
    !editUserAccountEmail ||
    !editUserIsAdmin ||
    !editUserCanEditArticles
  ) {
    return
  }

  editSelectedUserButton.addEventListener('click', () => {
    const user = getSelectedUser()

    if (!user) {
      usersTableMessage.textContent = 'Select one user before clicking Edit.'
      clearSelectedUser()
      return
    }

    editOriginalEmail = normalizeEmail(user.email)
    editUserId.value = user.user_id || ''
    editUserName.value = user.name || ''
    editUserAccountEmail.value = editOriginalEmail
    editUserIsAdmin.checked = user.is_admin === true
    editUserCanEditArticles.checked = user.can_edit_articles === true
    editSelectedUserMessage.textContent = ''
    openModal('editUserModal', editUserName)
  })

  editSelectedUserForm.addEventListener('submit', async event => {
    event.preventDefault()

    const selectedUser = getSelectedUser()
    const submitButton = editSelectedUserForm.querySelector('button[type="submit"]')
    const name = editUserName.value.trim()
    const email = normalizeEmail(editUserAccountEmail.value)
    const userId = editUserId.value.trim()
    const isAdmin = editUserIsAdmin.checked === true
    const canEditArticles = editUserCanEditArticles.checked === true

    if (!selectedUser || !editOriginalEmail) {
      editSelectedUserMessage.textContent = 'The selected user is no longer available. Close the modal and select the user again.'
      return
    }

    if (!name || !email) {
      editSelectedUserMessage.textContent = 'Enter the user name and email address.'
      return
    }

    setButtonLoading(submitButton, true, 'Saving Changes...', 'Save Changes')
    editSelectedUserMessage.textContent = 'Saving user changes...'

    try {
      await sendAdminRequest('/user-settings', {
        action: 'update',
        userId,
        originalEmail: editOriginalEmail,
        name,
        email,
        isAdmin,
        canEditArticles
      })

      const {
        data: { session }
      } = await supabase.auth.getSession()

      const editingSignedInUser =
        (userId && session?.user?.id === userId) ||
        normalizeEmail(session?.user?.email) === editOriginalEmail

      if (editingSignedInUser && email !== editOriginalEmail) {
        const { error: refreshError } = await supabase.auth.refreshSession()

        if (refreshError) {
          console.warn('Session refresh after email update failed:', refreshError)
        }
      }

      editSelectedUserMessage.textContent = 'User updated successfully.'
      selectedUserKey = userId || email
      editOriginalEmail = email
      await loadUsers()
      window.setTimeout(() => closeModal('editUserModal'), 500)
    } catch (error) {
      console.error('Update user error:', error)
      editSelectedUserMessage.textContent = `Unable to update user: ${getErrorMessage(error)}`
    } finally {
      setButtonLoading(submitButton, false, 'Saving Changes...', 'Save Changes')
    }
  })
}

function initializeDeleteUserModal() {
  if (
    !deleteSelectedUserButton ||
    !deleteUserSummary ||
    !deleteUserMessage ||
    !confirmDeleteUserButton
  ) {
    return
  }

  deleteSelectedUserButton.addEventListener('click', () => {
    const user = getSelectedUser()

    if (!user) {
      usersTableMessage.textContent = 'Select one user before clicking Delete.'
      clearSelectedUser()
      return
    }

    const name = user.name || 'Unnamed user'
    const email = normalizeEmail(user.email)
    deleteUserSummary.textContent = `${name} — ${email}`
    deleteUserMessage.textContent = ''
    openModal('deleteUserModal', cancelDeleteUserButton)
  })

  confirmDeleteUserButton.addEventListener('click', async () => {
    const user = getSelectedUser()

    if (!user) {
      deleteUserMessage.textContent = 'The selected user is no longer available. Close this popup and select the user again.'
      return
    }

    const userId = user.user_id || ''
    const email = normalizeEmail(user.email)

    setButtonLoading(confirmDeleteUserButton, true, 'Deleting...', 'Yes')
    deleteUserMessage.textContent = 'Deleting user...'

    try {
      await sendAdminRequest('/delete-user', {
        userId,
        email
      })

      clearSelectedUser()
      closeModal('deleteUserModal')
      await loadUsers()
      usersTableMessage.textContent = 'User deleted successfully.'
    } catch (error) {
      console.error('Delete user error:', error)
      deleteUserMessage.textContent = `Unable to delete user: ${getErrorMessage(error)}`
    } finally {
      setButtonLoading(confirmDeleteUserButton, false, 'Deleting...', 'Yes')
      updateSelectionButtonState()
    }
  })
}

function initializePasswordForm() {
  if (!changePasswordForm || !changePasswordMessage) {
    return
  }

  changePasswordForm.addEventListener('submit', async event => {
    event.preventDefault()

    const emailInput = document.getElementById('changeEmail')
    const passwordInput = document.getElementById('newPassword')
    const submitButton = changePasswordForm.querySelector('button[type="submit"]')
    const email = normalizeEmail(emailInput?.value)
    const password = passwordInput?.value ?? ''

    if (!email || !password) {
      changePasswordMessage.textContent = 'Enter the user email and new password.'
      return
    }

    if (password.length < 8) {
      changePasswordMessage.textContent = 'The new password must contain at least 8 characters.'
      return
    }

    setButtonLoading(submitButton, true, 'Updating Password...', 'Change Password')
    changePasswordMessage.textContent = 'Updating password...'

    try {
      await sendAdminRequest('/change-password', { email, password })
      changePasswordForm.reset()
      changePasswordMessage.textContent = 'Password changed successfully.'
    } catch (error) {
      console.error('Change-password error:', error)
      changePasswordMessage.textContent = `Unable to change password: ${getErrorMessage(error)}`
    } finally {
      setButtonLoading(submitButton, false, 'Updating Password...', 'Change Password')
    }
  })
}

async function initializeAdminPage() {
  try {
    const session = await requireAdminAccess()

    if (!session) {
      return
    }

    initializeModalControls()
    initializeAddUserForm()
    initializeEditUserModal()
    initializeDeleteUserModal()
    initializePasswordForm()

    refreshUsersButton?.addEventListener('click', loadUsers)
    await loadUsers()
  } catch (error) {
    console.error('Admin page initialization error:', error)
    alert('Unable to verify admin access.')
    redirectToDashboard()
  }
}

initializeAdminPage()
