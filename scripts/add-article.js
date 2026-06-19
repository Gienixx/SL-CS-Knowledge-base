import { supabase } from './supabaseClient.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const submitButton = form.querySelector('button[type="submit"]')

async function initializeArticleEditor() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError || !user) {
    window.location.replace('./login.html')
    return
  }

  const email = user.email?.trim().toLowerCase()

  if (!email) {
    window.location.replace('./login.html')
    return
  }

  const {
    data: allowedUser,
    error: permissionError
  } = await supabase
    .from('login')
    .select('name, can_edit_articles')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) {
    console.error('Permission check error:', permissionError)
    alert('Unable to verify article editor access.')
    window.location.replace('./dashboard.html')
    return
  }

  if (!allowedUser || allowedUser.can_edit_articles !== true) {
    alert('Article editor access only.')
    window.location.replace('./dashboard.html')
    return
  }

  const authorName = allowedUser.name?.trim() || email

  form.addEventListener('submit', async event => {
    event.preventDefault()

    const title = document.getElementById('title').value.trim()
    const tag = document.getElementById('tag').value
    const content = document.getElementById('content').value.trim()

    if (!title || !content || !['tickets', 'cashouts'].includes(tag)) {
      message.textContent = 'Please complete all article fields.'
      return
    }

    submitButton.disabled = true
    message.textContent = 'Saving article...'

    const { error: insertError } = await supabase
      .from('articles')
      .insert({
        title,
        content,
        tag,
        author_name: authorName
      })

    submitButton.disabled = false

    if (insertError) {
      console.error('Article insert error:', insertError)
      message.textContent =
        `Unable to save article: ${insertError.message}`
      return
    }

    message.textContent = 'Article saved successfully.'
    form.reset()
  })
}

initializeArticleEditor()
