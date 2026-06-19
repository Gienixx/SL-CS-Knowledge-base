import { supabase } from './supabaseClient.js'

const addUserForm =
document.getElementById('addUserForm')

const addUserMessage =
document.getElementById('message')

const editUserForm =
document.getElementById('editUserForm')

const editUserMessage =
document.getElementById(
'editUserMessage'
)

const editUserEmail =
document.getElementById(
'editUserEmail'
)

const loadUserSettingsBtn =
document.getElementById(
'loadUserSettingsBtn'
)

const editUserPermissions =
document.getElementById(
'editUserPermissions'
)

const editIsAdmin =
document.getElementById(
'editIsAdmin'
)

const editCanEditArticles =
document.getElementById(
'editCanEditArticles'
)

const changePasswordForm =
document.getElementById(
'changePasswordForm'
)

const changePasswordMessage =
document.getElementById(
'changePasswordMessage'
)

const usersTableBody =
document.getElementById(
'usersTableBody'
)

const usersTableMessage =
document.getElementById(
'usersTableMessage'
)

const refreshUsersButton =
document.getElementById(
'refreshUsersButton'
)

function normalizeEmail(value) {
return typeof value === 'string'
? value.trim().toLowerCase()
: ''
}

function getErrorMessage(error) {
if (
error &&
typeof error.message === 'string'
) {
return error.message
}

return 'An unexpected error occurred.'
}

function redirectToLogin() {
window.location.replace(
'./login.html'
)
}

function redirectToDashboard() {
window.location.replace(
'./dashboard.html'
)
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

const email =
normalizeEmail(
session.user.email
)

if (!email) {
redirectToLogin()
return null
}

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

if (
!allowedUser ||
allowedUser.is_admin !== true
) {
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
throw new Error(
'Your session has expired. Please sign in again.'
)
}

return session.access_token
}

async function parseResponse(
response
) {
const responseText =
await response.text()

if (!responseText) {
return {}
}

try {
return JSON.parse(responseText)
} catch {
return {
error: responseText
}
}
}

async function sendAdminRequest(
endpoint,
payload
) {
const accessToken =
await getAccessToken()

const response =
await fetch(
endpoint,
{
method: 'POST',


    headers: {
      'Content-Type':
        'application/json',

      Authorization:
        `Bearer ${accessToken}`
    },

    body: JSON.stringify(payload)
  }
)


const result =
await parseResponse(response)

if (!response.ok) {
throw new Error(
result.error ||
result.message ||
`Request failed with status ${response.status}.`
)
}

return result
}

async function sendAdminGetRequest(
endpoint
) {
const accessToken =
await getAccessToken()

const response =
await fetch(
endpoint,
{
method: 'GET',


    headers: {
      Authorization:
        `Bearer ${accessToken}`
    }
  }
)


const result =
await parseResponse(response)

if (!response.ok) {
throw new Error(
result.error ||
result.message ||
`Request failed with status ${response.status}.`
)
}

return result
}

function setButtonLoading(
button,
loading,
loadingText,
normalText
) {
if (!button) {
return
}

button.disabled = loading

button.textContent =
loading
? loadingText
: normalText
}

function createUsersTableCell(
value,
className = ''
) {
const cell =
document.createElement('td')

cell.textContent =
value === null ||
value === undefined ||
value === ''
? '—'
: String(value)

if (className) {
cell.className = className
}

return cell
}

function createPermissionCell(
enabled
) {
const cell =
document.createElement('td')

const badge =
document.createElement('span')

badge.className =
enabled
? 'user-status user-status-yes'
: 'user-status user-status-no'

badge.textContent =
enabled ? 'Yes' : 'No'

cell.appendChild(badge)

return cell
}

function showUsersTableMessage(
message
) {
if (!usersTableBody) {
return
}

usersTableBody.innerHTML = ''

const row =
document.createElement('tr')

const cell =
document.createElement('td')

cell.colSpan = 5
cell.className =
'users-table-empty'

cell.textContent = message

row.appendChild(cell)

usersTableBody.appendChild(row)
}

function renderUsers(users) {
if (!usersTableBody) {
return
}

usersTableBody.innerHTML = ''

if (
!Array.isArray(users) ||
users.length === 0
) {
showUsersTableMessage(
'No users were found.'
)


return


}

users.forEach(user => {
const row =
document.createElement('tr')


row.appendChild(
  createUsersTableCell(
    user.user_id,
    'users-table-id'
  )
)

row.appendChild(
  createUsersTableCell(
    user.name
  )
)

row.appendChild(
  createUsersTableCell(
    user.email
  )
)

row.appendChild(
  createPermissionCell(
    user.is_admin === true
  )
)

row.appendChild(
  createPermissionCell(
    user.can_edit_articles === true
  )
)

usersTableBody.appendChild(row)


})
}

async function loadUsers() {
if (
!usersTableBody ||
!usersTableMessage
) {
return
}

showUsersTableMessage(
'Loading users...'
)

usersTableMessage.textContent = ''

setButtonLoading(
refreshUsersButton,
true,
'Refreshing...',
'Refresh'
)

try {
const result =
await sendAdminGetRequest(
'/list-users'
)


const users =
  Array.isArray(result.users)
    ? result.users
    : []

renderUsers(users)

usersTableMessage.textContent =
  `${users.length} user${
    users.length === 1
      ? ''
      : 's'
  } found.`


} catch (error) {
console.error(
'Load users error:',
error
)


showUsersTableMessage(
  'Unable to load users.'
)

usersTableMessage.textContent =
  getErrorMessage(error)


} finally {
setButtonLoading(
refreshUsersButton,
false,
'Refreshing...',
'Refresh'
)
}
}

function initializeAddUserForm() {
if (
!addUserForm ||
!addUserMessage
) {
return
}

addUserForm.addEventListener(
'submit',
async event => {
event.preventDefault()


  const nameInput =
    document.getElementById(
      'name'
    )

  const emailInput =
    document.getElementById(
      'email'
    )

  const passwordInput =
    document.getElementById(
      'password'
    )

  const isAdminInput =
    document.getElementById(
      'isAdmin'
    )

  const canEditArticlesInput =
    document.getElementById(
      'canEditArticles'
    )

  const submitButton =
    addUserForm.querySelector(
      'button[type="submit"]'
    )

  const name =
    nameInput?.value.trim() ?? ''

  const email =
    normalizeEmail(
      emailInput?.value
    )

  const password =
    passwordInput?.value ?? ''

  const isAdmin =
    isAdminInput?.checked === true

  const canEditArticles =
    canEditArticlesInput
      ?.checked === true

  if (
    !name ||
    !email ||
    !password
  ) {
    addUserMessage.textContent =
      'Enter the user name, email address, and temporary password.'

    return
  }

  if (password.length < 8) {
    addUserMessage.textContent =
      'The temporary password must contain at least 8 characters.'

    return
  }

  setButtonLoading(
    submitButton,
    true,
    'Adding User...',
    'Add User'
  )

  addUserMessage.textContent =
    'Creating user...'

  try {
    await sendAdminRequest(
      '/create-user',
      {
        name,
        email,
        password,
        isAdmin,
        canEditArticles
      }
    )

    addUserForm.reset()

    addUserMessage.textContent =
      'User created successfully.'

    await loadUsers()
  } catch (error) {
    console.error(
      'Create-user error:',
      error
    )

    addUserMessage.textContent =
      `Unable to create user: ${getErrorMessage(error)}`
  } finally {
    setButtonLoading(
      submitButton,
      false,
      'Adding User...',
      'Add User'
    )
  }
}


)
}

function initializeEditUserForm() {
if (
!editUserForm ||
!editUserMessage ||
!editUserEmail ||
!loadUserSettingsBtn ||
!editUserPermissions ||
!editIsAdmin ||
!editCanEditArticles
) {
return
}

let loadedEmail = ''

function clearLoadedSettings() {
loadedEmail = ''


editUserPermissions.hidden =
  true

editIsAdmin.checked = false

editCanEditArticles.checked =
  false


}

editUserEmail.addEventListener(
'input',
() => {
const currentEmail =
normalizeEmail(
editUserEmail.value
)


  if (
    loadedEmail &&
    currentEmail !== loadedEmail
  ) {
    clearLoadedSettings()

    editUserMessage.textContent =
      'Click Load Current Settings for this email address.'
  }
}


)

loadUserSettingsBtn.addEventListener(
'click',
async () => {
const email =
normalizeEmail(
editUserEmail.value
)


  if (!email) {
    editUserMessage.textContent =
      'Enter the user email first.'

    return
  }

  clearLoadedSettings()

  setButtonLoading(
    loadUserSettingsBtn,
    true,
    'Loading Settings...',
    'Load Current Settings'
  )

  editUserMessage.textContent =
    'Loading current settings...'

  try {
    const result =
      await sendAdminRequest(
        '/user-settings',
        {
          action: 'get',
          email
        }
      )

    const currentInputEmail =
      normalizeEmail(
        editUserEmail.value
      )

    if (
      currentInputEmail !== email
    ) {
      editUserMessage.textContent =
        'The email address changed. Load the settings again.'

      return
    }

    editIsAdmin.checked =
      result.user?.is_admin === true

    editCanEditArticles.checked =
      result.user
        ?.can_edit_articles === true

    loadedEmail = email

    editUserPermissions.hidden =
      false

    editUserMessage.textContent =
      'Current user settings loaded.'
  } catch (error) {
    console.error(
      'Load user settings error:',
      error
    )

    clearLoadedSettings()

    editUserMessage.textContent =
      `Unable to load settings: ${getErrorMessage(error)}`
  } finally {
    setButtonLoading(
      loadUserSettingsBtn,
      false,
      'Loading Settings...',
      'Load Current Settings'
    )
  }
}


)

editUserForm.addEventListener(
'submit',
async event => {
event.preventDefault()


  const email =
    normalizeEmail(
      editUserEmail.value
    )

  const submitButton =
    editUserForm.querySelector(
      'button[type="submit"]'
    )

  if (
    !loadedEmail ||
    email !== loadedEmail
  ) {
    clearLoadedSettings()

    editUserMessage.textContent =
      'Load the current user settings before saving.'

    return
  }

  const isAdmin =
    editIsAdmin.checked === true

  const canEditArticles =
    editCanEditArticles
      .checked === true

  setButtonLoading(
    submitButton,
    true,
    'Saving Settings...',
    'Save Settings'
  )

  editUserMessage.textContent =
    'Saving user settings...'

  try {
    const result =
      await sendAdminRequest(
        '/user-settings',
        {
          action: 'update',
          email,
          isAdmin,
          canEditArticles
        }
      )

    editIsAdmin.checked =
      result.user?.is_admin === true

    editCanEditArticles.checked =
      result.user
        ?.can_edit_articles === true

    editUserMessage.textContent =
      'User settings updated successfully.'

    await loadUsers()
  } catch (error) {
    console.error(
      'Update user settings error:',
      error
    )

    editUserMessage.textContent =
      `Unable to update settings: ${getErrorMessage(error)}`
  } finally {
    setButtonLoading(
      submitButton,
      false,
      'Saving Settings...',
      'Save Settings'
    )
  }
}


)
}

function initializePasswordForm() {
if (
!changePasswordForm ||
!changePasswordMessage
) {
return
}

changePasswordForm.addEventListener(
'submit',
async event => {
event.preventDefault()


  const emailInput =
    document.getElementById(
      'changeEmail'
    )

  const passwordInput =
    document.getElementById(
      'newPassword'
    )

  const submitButton =
    changePasswordForm.querySelector(
      'button[type="submit"]'
    )

  const email =
    normalizeEmail(
      emailInput?.value
    )

  const password =
    passwordInput?.value ?? ''

  if (!email || !password) {
    changePasswordMessage.textContent =
      'Enter the user email and new password.'

    return
  }

  if (password.length < 8) {
    changePasswordMessage.textContent =
      'The new password must contain at least 8 characters.'

    return
  }

  setButtonLoading(
    submitButton,
    true,
    'Updating Password...',
    'Change Password'
  )

  changePasswordMessage.textContent =
    'Updating password...'

  try {
    await sendAdminRequest(
      '/change-password',
      {
        email,
        password
      }
    )

    changePasswordForm.reset()

    changePasswordMessage.textContent =
      'Password changed successfully.'
  } catch (error) {
    console.error(
      'Change-password error:',
      error
    )

    changePasswordMessage.textContent =
      `Unable to change password: ${getErrorMessage(error)}`
  } finally {
    setButtonLoading(
      submitButton,
      false,
      'Updating Password...',
      'Change Password'
    )
  }
}


)
}

async function initializeAdminPage() {
try {
const session =
await requireAdminAccess()


if (!session) {
  return
}

initializeAddUserForm()
initializeEditUserForm()
initializePasswordForm()

if (refreshUsersButton) {
  refreshUsersButton.addEventListener(
    'click',
    loadUsers
  )
}

await loadUsers()


} catch (error) {
console.error(
'Admin page initialization error:',
error
)


alert(
  'Unable to verify admin access.'
)

redirectToDashboard()


}
}

initializeAdminPage()
