import { supabase } from './supabaseClient.js'

const form = document.getElementById('loginForm')
const message = document.getElementById('message')

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const email = document.getElementById('email').value
  const password = document.getElementById('password').value

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  })

  if (error) {
    message.textContent = error.message
    return
  }

  window.location.href = './dashboard.html'
})
