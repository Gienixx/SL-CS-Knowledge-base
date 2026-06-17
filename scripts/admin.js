import { supabase } from './supabaseClient.js'

async function checkAdminAccess() {
  const {
    data: { user }
  } = await supabase.auth.getUser()

  if (!user) {
    window.location.href = './login.html'
    return false
  }

  const email = user.email.trim().toLowerCase()

  const { data: rows, error } = await supabase
    .from('login')
    .select('email, is_admin')

  if (error) {
    alert('Unable to verify admin access.')
    window.location.href = './dashboard.html'
    return false
  }

  const allowedUser = rows?.find(
    row => row.email?.trim().toLowerCase() === email
  )

  if (!allowedUser || allowedUser.is_admin !== true) {
    alert('Admin access only.')
    window.location.href = './dashboard.html'
    return false
  }

  return true
}

const isAdmin = await checkAdminAccess()

if (!isAdmin) {
  throw new Error('Admin access denied')
}

const form = document.getElementById('addUserForm')
const message = document.getElementById('message')

if (!form) {
  throw new Error('addUserForm not found')
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const email = document.getElementById('email').value.trim()
  const password = document.getElementById('password').value

  const response = await fetch('/create-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  })

  const result = await response.json()

  if (!response.ok || !result.success) {
    message.textContent = result.error || JSON.stringify(result)
    return
  }

  message.textContent = 'User created successfully'
  form.reset()
})

const changePasswordForm =
  document.getElementById('changePasswordForm')

const changePasswordMessage =
  document.getElementById('changePasswordMessage')

if (!changePasswordForm) {
  throw new Error('changePasswordForm not found')
}

changePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault()

  const email = document.getElementById('changeEmail').value.trim()
  const password = document.getElementById('newPassword').value

  const response = await fetch('/change-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  })

  const result = await response.json()

  if (!response.ok) {
    changePasswordMessage.textContent = result.error || 'Failed to change password'
    return
  }

  changePasswordMessage.textContent = 'Password changed successfully'
  changePasswordForm.reset()
})
