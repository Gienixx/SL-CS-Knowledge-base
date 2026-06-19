import { supabase } from './supabaseClient.js'

const form = document.getElementById('articleForm')
const message = document.getElementById('message')
const submitButton = form?.querySelector('button[type="submit"]')

async function initializeArticleEditor() {
  if (!form || !message || !submitButton) {
    console.error('Article editor elements could not be found.')
    return
  }

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    console.error('Authentication error:', userError)
  }

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

    alert(
      `Unable to verify article editor access: ${permissionError.message}`
    )

    window.location.replace('./dashboard.html')
    return
  }

  if (
    !allowedUser ||
    allowedUser.can_edit_articles !== true
  ) {
    alert('Article editor access only.')
    window.location.replace('./dashboard.html')
    return
  }

  const authorName =
    allowedUser.name?.trim() ||
    user.user_metadata?.full_name?.trim() ||
    user.user_metadata?.name?.trim() ||
    email

  form.addEventListener('submit', async event => {
    event.preventDefault()

    const titleInput = document.getElementById('title')
    const tagInput = document.getElementById('tag')
    const contentInput = document.getElementById('content')

    const title = titleInput?.value.trim() ?? ''
    const tag = tagInput?.value.trim().toLowerCase() ?? ''
    const content = contentInput?.value.trim() ?? ''

    const validTags = ['tickets', 'cashouts']

    if (!title || !content || !validTags.includes(tag)) {
      message.textContent =
        'Please enter a title, choose a category, and add article content.'

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
        author_name: authorName,
        published: true
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
