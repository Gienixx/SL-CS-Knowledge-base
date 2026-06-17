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

  const text = await response.text()

  console.log('STATUS:', response.status)
  console.log('RAW RESPONSE:', text)

  let result = {}

  try {
    result = JSON.parse(text)
  } catch {
    result = { raw: text }
  }

  if (!response.ok || !result.success) {
    message.textContent = JSON.stringify(result)
    return
  }

  message.textContent = 'User created successfully'
  form.reset()
})
