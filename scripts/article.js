import { supabase } from './supabaseClient.js'

const titleElement =
  document.getElementById('articleTitle')

const metaElement =
  document.getElementById('articleMeta')

const contentElement =
  document.getElementById('articleContent')

const errorElement =
  document.getElementById('articleError')

async function loadArticle() {
  if (
    !titleElement ||
    !metaElement ||
    !contentElement ||
    !errorElement
  ) {
    console.error('Article display elements were not found.')
    return
  }

  const params =
    new URLSearchParams(window.location.search)

  const articleId = params.get('id')

  if (!articleId) {
    showError('No article was selected.')
    return
  }

  const {
    data: article,
    error
  } = await supabase
    .from('articles')
    .select(
      'title, content, tag, author_name, published'
    )
    .eq('id', articleId)
    .eq('published', true)
    .maybeSingle()

  if (error) {
    console.error('Article loading error:', error)

    showError(
      `Unable to load article: ${error.message}`
    )

    return
  }

  if (!article) {
    showError(
      'The requested article could not be found or is not published.'
    )

    return
  }

  const normalizedTag = String(article.tag ?? '')
    .trim()
    .toLowerCase()

  const category =
    normalizedTag === 'cashouts'
      ? 'Cashouts'
      : 'Tickets'

  document.title =
    `${article.title} | SocialLoop CS Base`

  titleElement.textContent =
    article.title || 'Untitled Article'

  contentElement.textContent =
    article.content || ''

  errorElement.textContent = ''

  metaElement.textContent =
    article.author_name
      ? `${category} • Written by ${article.author_name}`
      : category
}

function showError(message) {
  titleElement.textContent = 'Article unavailable'
  metaElement.textContent = ''
  contentElement.textContent = ''
  errorElement.textContent = message
}

loadArticle()
