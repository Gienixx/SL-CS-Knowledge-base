import { supabase } from './supabaseClient.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')

const {
  data: { user }
} = await supabase.auth.getUser()

if (!user) {
  window.location.href = './login.html'
}

const email = user.email.trim().toLowerCase()

const { data: rows } = await supabase
  .from('login')
  .select('email, can_edit_articles')

const allowedUser = rows?.find(
  row => row.email?.trim().toLowerCase() === email
)

if (!allowedUser || allowedUser.can_edit_articles !== true) {
  alert('Article editor access only.')
  window.location.href = './dashboard.html'
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const title = document.getElementById('title').value.trim()
  const content = document.getElementById('content').value.trim()

  const { error } = await supabase
    .from('articles')
    .insert({
      title,
      content,
      author_email: email
    })

  if (error) {
    message.textContent = error.message
    return
  }

  message.textContent = 'Article saved successfully.'
  form.reset()
})
