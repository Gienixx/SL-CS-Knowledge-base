import { supabase } from './supabaseClient.js'

const titleElement = document.getElementById('articleTitle')
const metaElement = document.getElementById('articleMeta')
const contentElement = document.getElementById('articleContent')
const errorElement = document.getElementById('articleError')

async function loadArticle() {
  const params = new URLSearchParams(window.location.search)
  const articleId = params.get('id')

  if (!articleId) {
    showError('No article was selected.')
    return
  }

  const { data: article, error } = await supabase
    .from('articles')
    .select('title, content, tag, author_email, created_at')
    .eq('id', articleId)
    .eq('published', true)
    .maybeSingle()

  if (error || !article) {
    console.error('Article loading error:', error)
    showError('The requested article could not be found.')
    return
  }

  document.title = `${article.title} | SocialLoop CS Base`
  titleElement.textContent = article.title
  contentElement.textContent = article.content

  const category =
    article.tag === 'cashouts' ? 'Cashouts' : 'Tickets'

  const createdDate = new Date(article.created_at).toLocaleDateString()

  metaElement.textContent = `${category} • ${createdDate}`
}

function showError(message) {
  titleElement.textContent = 'Article unavailable'
  metaElement.textContent = ''
  contentElement.textContent = ''
  errorElement.textContent = message
}

loadArticle()
