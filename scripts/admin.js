import { supabase } from './supabaseClient.js'

const addUserForm =
document.getElementById('addUserForm')

const addUserMessage =
document.getElementById('message')

const changePasswordForm =
document.getElementById('changePasswordForm')

const changePasswordMessage =
document.getElementById('changePasswordMessage')

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

const email =
session.user.email
?.trim()
.toLowerCase()

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

async function sendAdminRequest(
endpoint,
payload
) {
const accessToken =
await getAccessToken()

const response = await fetch(
endpoint,
{
method: 'POST',
headers: {
'Content-Type':
'application/json',

```
    Authorization:
      `Bearer ${accessToken}`
  },

  body: JSON.stringify(payload)
}
```

)

const responseText =
await response.text()

let result = {}

if (responseText) {
try {
result =
JSON.parse(responseText)
} catch {
result = {
error: responseText
}
}
}

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

```
  const emailInput =
    document.getElementById('email')

  const passwordInput =
    document.getElementById('password')

  const submitButton =
    addUserForm.querySelector(
      'button[type="submit"]'
    )

  const email =
    emailInput?.value
      .trim()
      .toLowerCase() ?? ''

  const password =
    passwordInput?.value ?? ''

  if (!email || !password) {
    addUserMessage.textContent =
      'Enter an email address and temporary password.'

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
        email,
        password
      }
    )

    addUserForm.reset()

    addUserMessage.textContent =
      'User created successfully.'
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
```

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

```
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
    emailInput?.value
      .trim()
      .toLowerCase() ?? ''

  const password =
    passwordInput?.value ?? ''

  if (!email || !password) {
    changePasswordMessage.textContent =
      'Enter the user email and new password.'

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
```

)
}

async function initializeAdminPage() {
try {
const session =
await requireAdminAccess()

```
if (!session) {
  return
}

initializeAddUserForm()
initializePasswordForm()
```

} catch (error) {
console.error(
'Admin page initialization error:',
error
)

```
alert(
  'Unable to verify admin access.'
)

redirectToDashboard()
```

}
}

initializeAdminPage()
