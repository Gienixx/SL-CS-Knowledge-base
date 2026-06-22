import { supabase } from './supabaseClient.js'

const articleList = document.getElementById('articleList')
const articleCount = document.getElementById('articleCount')
const statusElement = document.getElementById('articleManagementStatus')
const refreshButton = document.getElementById('refreshArticlesButton')

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function getErrorMessage(error) {
  return error && typeof error.message === 'string'
    ? error.message
    : 'An unexpected error occurred.'
}

function formatArticleDate(value) {
  if (!value) {
    return 'Date unavailable'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable'
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

function getCategoryLabel(tag) {
  const normalizedTag = String(tag ?? '')
    .trim()
    .toLowerCase()

  if (normalizedTag === 'cashouts') {
    return 'Cashouts'
  }

  if (normalizedTag === 'tickets') {
    return 'Tickets'
  }

  return normalizedTag || 'Uncategorized'
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName)
  element.className = className
  element.textContent = text
  return element
}

function showListMessage(message, className = 'article-empty') {
  if (!articleList) {
    return
  }

  articleList.replaceChildren()
  const messageElement = document.createElement('p')
  messageElement.className = className
  messageElement.textContent = message
  articleList.appendChild(messageElement)
}

function createArticleItem(article) {
  const item = document.createElement('article')
  item.className = 'article-list-item'

  const content = document.createElement('div')
  content.className = 'article-list-content'

  const heading = document.createElement('div')
  heading.className = 'article-list-heading'

  const title = createTextElement(
    'h2',
    '',
    String(article.title ?? '').trim() || 'Untitled Article'
  )

  const categoryBadge = createTextElement(
    'span',
    'article-badge',
    getCategoryLabel(article.tag)
  )

  const publicationBadge = createTextElement(
    'span',
    article.published === true
      ? 'article-badge'
      : 'article-badge article-badge-draft',
    article.published === true ? 'Published' : 'Draft'
  )

  heading.append(title, categoryBadge, publicationBadge)

  const description = createTextElement(
    'p',
    'article-description',
    String(article.description ?? '').trim() ||
      'No article description was provided.'
  )

  const meta = document.createElement('div')
  meta.className = 'article-meta'

  const author = createTextElement(
    'span',
    '',
    `Author: ${String(article.author_name ?? '').trim() || 'Not specified'}`
  )

  const createdDate = createTextElement(
    'span',
    '',
    `Created: ${formatArticleDate(article.created_at)}`
  )

  meta.append(author, createdDate)
  content.append(heading, description, meta)

  const openLink = document.createElement('a')
  openLink.className =
    'management-button article-open-link'
  openLink.href =
    `./article.html?id=${encodeURIComponent(article.id)}`
  openLink.textContent = 'Preview Article'

  if (article.published !== true) {
    openLink.href = '#'
    openLink.setAttribute('aria-disabled', 'true')
    openLink.addEventListener('click', event => {
      event.preventDefault()
    })
  }

  item.append(content, openLink)
  return item
}

function renderArticles(articles) {
  if (!articleList || !articleCount) {
    return
  }

  articleList.replaceChildren()

  if (!Array.isArray(articles) || articles.length === 0) {
    articleCount.textContent = '0 articles'
    showListMessage(
      'No articles have been created yet. Select Add Article to create the first one.'
    )
    return
  }

  articleCount.textContent =
    `${articles.length} article${articles.length === 1 ? '' : 's'}`

  for (const article of articles) {
    articleList.appendChild(createArticleItem(article))
  }
}

async function requireArticleEditorAccess() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!user) {
    window.location.replace(
      './login.html?returnTo=/article-management.html'
    )
    return false
  }

  const email = normalizeEmail(user.email)

  if (!email) {
    await supabase.auth.signOut()
    window.location.replace('./login.html')
    return false
  }

  const {
    data: allowedUser,
    error: permissionError
  } = await supabase
    .from('login')
    .select('can_edit_articles')
    .ilike('email', email)
    .maybeSingle()

  if (permissionError) {
    throw permissionError
  }

  if (!allowedUser || allowedUser.can_edit_articles !== true) {
    alert('Article editor access only.')
    window.location.replace('./dashboard.html')
    return false
  }

  return true
}

async function loadArticles() {
  if (!articleList || !articleCount || !refreshButton) {
    console.error('Required article management elements were not found.')
    return
  }

  refreshButton.disabled = true
  articleCount.textContent = 'Loading articles...'
  statusElement.textContent = ''
  showListMessage('Loading created articles...')

  try {
    const hasAccess = await requireArticleEditorAccess()

    if (!hasAccess) {
      return
    }

    const { data, error } = await supabase
      .from('articles')
      .select(`
        id,
        title,
        description,
        tag,
        author_name,
        published,
        created_at
      `)
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    renderArticles(Array.isArray(data) ? data : [])
    statusElement.textContent = 'Article list is up to date.'
  } catch (error) {
    console.error('Article management loading error:', error)
    articleCount.textContent = 'Unable to load articles'
    statusElement.textContent = getErrorMessage(error)
    showListMessage(
      `Unable to load articles: ${getErrorMessage(error)}`,
      'article-error'
    )
  } finally {
    refreshButton.disabled = false
  }
}

refreshButton?.addEventListener('click', loadArticles)
loadArticles()
