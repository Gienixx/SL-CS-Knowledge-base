const form = document.getElementById('addUserForm')
const message = document.getElementById('message')

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

const changePasswordForm = document.getElementById('changePasswordForm')
const changePasswordMessage = document.getElementById('changePasswordMessage')

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
