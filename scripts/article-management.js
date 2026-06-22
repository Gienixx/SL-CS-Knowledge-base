import { supabase } from './supabaseClient.js'
import {
  parseArticleContent,
  renderArticleUnit
} from './article-content-renderer-v7.js?v=1'
import './article-nesting-styles.js?v=1'
import './article-preview-parser-styles.js?v=1'

const articleList = document.getElementById('articleList')
const articleCount = document.getElementById('articleCount')
const statusElement = document.getElementById('articleManagementStatus')
const refreshButton = document.getElementById('refreshArticlesButton')
const previewPanel = document.getElementById('articlePreviewPanel')
const previewCategory = document.getElementById('previewCategory')
const previewCover = document.getElementById('previewCover')
const previewTitle = document.getElementById('previewTitle')
const previewAuthor = document.getElementById('previewAuthor')
const previewDate = document.getElementById('previewDate')
const previewStatus = document.getElementById('previewStatus')
const previewDescription = document.getElementById('previewDescription')
const previewBody = document.getElementById('previewBody')
const openPublishedArticleLink = document.getElementById(
  'openPublishedArticleLink'
)

let articlesCache = []
let selectedArticleId = ''

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

function isMissingImageColumnError(error) {
  const message = String(error?.message || '').toLowerCase()

  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('image_url')
  )
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

function normalizeImageUrl(value) {
  const rawValue = String(value ?? '').trim()

  if (!rawValue) {
    return ''
  }

  try {
    const url = new URL(rawValue, document.baseURI)

    if (!['http:', 'https:'].includes(url.protocol)) {
      return ''
    }

    return url.href
  } catch {
    return ''
  }
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

function resetPreview(messageText = 'Select an article from the list to preview it here.') {
  selectedArticleId = ''

  if (previewCategory) {
    previewCategory.textContent = 'No article selected'
  }

  if (previewCover) {
    previewCover.hidden = true
    previewCover.removeAttribute('src')
  }

  if (previewTitle) {
    previewTitle.textContent = 'Select an Article'
  }

  if (previewAuthor) {
    previewAuthor.textContent = 'By: Not specified'
  }

  if (previewDate) {
    previewDate.textContent = 'Date unavailable'
  }

  if (previewStatus) {
    previewStatus.textContent = 'No status'
  }

  if (previewDescription) {
    previewDescription.textContent = messageText
  }

  if (previewBody) {
    previewBody.replaceChildren()
    const empty = createTextElement(
      'p',
      'preview-empty',
      'The selected article content will appear here.'
    )
    previewBody.appendChild(empty)
  }

  if (openPublishedArticleLink) {
    openPublishedArticleLink.hidden = true
    openPublishedArticleLink.href = '#'
  }
}

function renderPreview(article) {
  if (
    !article ||
    !previewCategory ||
    !previewCover ||
    !previewTitle ||
    !previewAuthor ||
    !previewDate ||
    !previewStatus ||
    !previewDescription ||
    !previewBody ||
    !openPublishedArticleLink
  ) {
    return
  }

  selectedArticleId = String(article.id)
  previewCategory.textContent = getCategoryLabel(article.tag)
  previewTitle.textContent =
    String(article.title ?? '').trim() || 'Untitled Article'
  previewAuthor.textContent =
    `By: ${String(article.author_name ?? '').trim() || 'Not specified'}`
  previewDate.textContent = formatArticleDate(article.created_at)
  previewStatus.textContent =
    article.published === true ? 'Published' : 'Draft'
  previewDescription.textContent =
    String(article.description ?? '').trim() ||
    'No article description was provided.'

  const imageUrl = normalizeImageUrl(article.image_url)

  if (imageUrl) {
    previewCover.src = imageUrl
    previewCover.hidden = false
    previewCover.onerror = () => {
      previewCover.hidden = true
      previewCover.removeAttribute('src')
    }
  } else {
    previewCover.hidden = true
    previewCover.removeAttribute('src')
  }

  previewBody.replaceChildren()
  const units = parseArticleContent(
    String(article.content ?? '')
  )

  if (!units.length) {
    previewBody.appendChild(
      createTextElement(
        'p',
        'preview-empty',
        'This article does not contain any formatted content yet.'
      )
    )
  } else {
    for (const unit of units) {
      previewBody.appendChild(renderArticleUnit(unit))
    }
  }

  if (article.published === true) {
    openPublishedArticleLink.href =
      `./article.html?id=${encodeURIComponent(article.id)}`
    openPublishedArticleLink.hidden = false
  } else {
    openPublishedArticleLink.href = '#'
    openPublishedArticleLink.hidden = true
  }

  document.querySelectorAll('.article-list-item').forEach(item => {
    item.classList.toggle(
      'is-selected',
      item.dataset.articleId === selectedArticleId
    )
  })

  document.querySelectorAll('.article-preview-button').forEach(button => {
    button.setAttribute(
      'aria-pressed',
      button.dataset.articleId === selectedArticleId
        ? 'true'
        : 'false'
    )
  })
}

function selectArticle(articleId, scrollPreview = false) {
  const article = articlesCache.find(
    item => String(item.id) === String(articleId)
  )

  if (!article) {
    return
  }

  renderPreview(article)

  if (
    scrollPreview &&
    window.matchMedia('(max-width: 1180px)').matches
  ) {
    previewPanel?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }
}

function createArticleItem(article) {
  const articleId = String(article.id)
  const item = document.createElement('article')
  item.className = 'article-list-item'
  item.dataset.articleId = articleId

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

  const previewButton = document.createElement('button')
  previewButton.className =
    'management-button article-preview-button'
  previewButton.type = 'button'
  previewButton.dataset.articleId = articleId
  previewButton.setAttribute('aria-pressed', 'false')
  previewButton.textContent = 'Preview Article'
  previewButton.addEventListener('click', () => {
    selectArticle(articleId, true)
  })

  item.append(content, previewButton)
  return item
}

function renderArticles(articles) {
  if (!articleList || !articleCount) {
    return
  }

  articlesCache = Array.isArray(articles) ? articles : []
  articleList.replaceChildren()

  if (articlesCache.length === 0) {
    articleCount.textContent = '0 articles'
    showListMessage(
      'No articles have been created yet. Select Add Article to create the first one.'
    )
    resetPreview(
      'Create an article first, then select it from the list to preview it here.'
    )
    return
  }

  articleCount.textContent =
    `${articlesCache.length} article${articlesCache.length === 1 ? '' : 's'}`

  for (const article of articlesCache) {
    articleList.appendChild(createArticleItem(article))
  }

  const articleToSelect =
    articlesCache.find(
      article => String(article.id) === selectedArticleId
    ) || articlesCache[0]

  renderPreview(articleToSelect)
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

async function fetchArticles() {
  let result = await supabase
    .from('articles')
    .select(`
      id,
      title,
      description,
      content,
      tag,
      author_name,
      image_url,
      published,
      created_at
    `)
    .order('created_at', { ascending: false })

  if (result.error && isMissingImageColumnError(result.error)) {
    result = await supabase
      .from('articles')
      .select(`
        id,
        title,
        description,
        content,
        tag,
        author_name,
        published,
        created_at
      `)
      .order('created_at', { ascending: false })
  }

  return result
}

async function loadArticles() {
  if (
    !articleList ||
    !articleCount ||
    !statusElement ||
    !refreshButton
  ) {
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

    const { data, error } = await fetchArticles()

    if (error) {
      throw error
    }

    renderArticles(Array.isArray(data) ? data : [])
    statusElement.textContent = 'Article list is up to date.'
  } catch (error) {
    console.error('Article management loading error:', error)
    articlesCache = []
    articleCount.textContent = 'Unable to load articles'
    statusElement.textContent = getErrorMessage(error)
    showListMessage(
      `Unable to load articles: ${getErrorMessage(error)}`,
      'article-error'
    )
    resetPreview('The article preview could not be loaded.')
  } finally {
    refreshButton.disabled = false
  }
}

refreshButton?.addEventListener('click', loadArticles)
loadArticles()
