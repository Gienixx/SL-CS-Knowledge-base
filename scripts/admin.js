const form = document.getElementById('addUserForm')
const message = document.getElementById('message')

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const email = document.getElementById('email').value
  const password = document.getElementById('password').value

  const response = await fetch('/create-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  })

  const result = await response.json()

  if (!response.ok) {
    message.textContent = result.error || 'Failed to create user'
    return
  }

  message.textContent = 'User created successfully'
  form.reset()
})
