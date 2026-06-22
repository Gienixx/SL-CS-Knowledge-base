import { supabase } from './supabaseClient.js'

const links = {
  LINKS: [
    {
      name: 'Demo Compilations',
      url:
        'https://drive.google.com/drive/folders/' +
        '1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX'
    },
    {
      name: 'Meeting Compilations',
      url:
        'https://drive.google.com/drive/folders/' +
        '1nt6ozbXVdq-lhA9MVSXnsm6Bt50Hdrx5?usp=sharing'
    }
  ]
}

let publishedArticles = []
let articlesLoaded = false
let activeCategory = 'ALL'
let searchRequestId = 0

function isMissingImageColumnError(error) {
  const message = String(error?.message || '').toLowerCase()

  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('image_url')
  )
}

async function fetchPublishedArticles() {
  let result = await supabase
    .from('articles')
    .select(
      'id, title, description, content, tag, author_name, image_url, published, created_at'
    )
    .eq('published', true)
    .order('created_at', { ascending: false })

  if (result.error && isMissingImageColumnError(result.error)) {
    result = await supabase
      .from('articles')
      .select(
        'id, title, description, content, tag, author_name, published, created_at'
      )
      .eq('published', true)
      .order('created_at', { ascending: false })
  }

  return result
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

function normalizeCategory(value) {
  const category = String(value ?? '').trim().toLowerCase()

  if (category === 'tickets' || category === 'cashouts') {
    return category
  }

  return ''
}

function createExcerpt(content, maximumLength = 170) {
  const normalized = String(content ?? '')
    .replace(/:::[^\n]*/g, ' ')
    .replace(/[#>*|\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return 'Open this article to read more.'
  }

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return `${normalized.slice(0, maximumLength).trim()}…`
}

function formatArticleDate(value) {
  if (!value) {
    return ''
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

function mapDatabaseArticle(row) {
  const category = normalizeCategory(row.tag)

  if (!category) {
    return null
  }

  const title = String(row.title ?? '').trim() || 'Untitled Article'
  const description =
    String(row.description ?? '').trim() ||
    createExcerpt(row.content)
  const author = String(row.author_name ?? '').trim()
  const publishedDate = formatArticleDate(row.created_at)
  const metaParts = []

  if (author) {
    metaParts.push(`Written by ${author}`)
  }

  if (publishedDate) {
    metaParts.push(publishedDate)
  }

  return {
    id: row.id,
    title,
    description,
    content: String(row.content ?? ''),
    category,
    status: metaParts.join(' · ') || 'Published article',
    image: normalizeImageUrl(row.image_url),
    url: `./article.html?id=${encodeURIComponent(row.id)}`,
    searchText: [
      title,
      description,
      row.content,
      author,
      category
    ]
      .join(' ')
      .toLowerCase()
  }
}

async function loadPublishedArticles({ force = false } = {}) {
  if (articlesLoaded && !force) {
    return publishedArticles
  }

  const { data, error } = await fetchPublishedArticles()

  if (error) {
    throw error
  }

  publishedArticles = (Array.isArray(data) ? data : [])
    .map(mapDatabaseArticle)
    .filter(Boolean)
  articlesLoaded = true
  return publishedArticles
}

function createImagePlaceholder() {
  const placeholder = document.createElement('div')
  placeholder.className = 'article-image-placeholder'
  placeholder.textContent = 'Knowledge Base Article'
  return placeholder
}

function createArticleImage(article) {
  if (!article.image) {
    return createImagePlaceholder()
  }

  const image = document.createElement('img')
  image.className = 'article-card-image'
  image.src = article.image
  image.alt = `${article.title} article cover`
  image.loading = 'lazy'
  image.decoding = 'async'
  image.style.width = '100%'
  image.style.height = '145px'
  image.style.objectFit = 'cover'
  image.style.display = 'block'

  image.addEventListener(
    'error',
    () => {
      image.replaceWith(createImagePlaceholder())
    },
    { once: true }
  )

  return image
}

function renderArticleGrid(articles) {
  const grid = document.createElement('div')
  grid.className = 'article-grid'

  if (!articles.length) {
    const emptyMessage = document.createElement('p')
    emptyMessage.className = 'article-empty-message'
    emptyMessage.textContent =
      'No published articles created through the article form are available here yet.'
    grid.appendChild(emptyMessage)
    return grid
  }

  for (const article of articles) {
    const card = document.createElement('article')
    card.className = 'article-card'
    card.dataset.articleId = String(article.id)
    card.dataset.category = article.category

    const wrapper = document.createElement('a')
    wrapper.href = article.url
    wrapper.className = 'article-card-link'
    wrapper.style.display = 'block'
    wrapper.style.color = 'inherit'
    wrapper.style.textDecoration = 'none'

    wrapper.appendChild(createArticleImage(article))

    const contentContainer = document.createElement('div')
    contentContainer.className = 'article-content'

    const category = document.createElement('span')
    category.className = 'article-category-label'
    category.textContent =
      article.category === 'cashouts' ? 'Cashouts' : 'Tickets'

    const title = document.createElement('h3')
    title.textContent = article.title

    const description = document.createElement('p')
    description.textContent = article.description

    const status = document.createElement('div')
    status.className = 'article-meta'
    status.textContent = article.status

    contentContainer.append(category, title, description, status)
    wrapper.appendChild(contentContainer)
    card.appendChild(wrapper)
    grid.appendChild(card)
  }

  return grid
}

function renderLinks(category, header, content) {
  header.textContent = 'Useful Links'

  const table = document.createElement('table')
  const tableHead = document.createElement('thead')
  const headingRow = document.createElement('tr')

  const nameHeading = document.createElement('th')
  nameHeading.textContent = 'Name'

  const linkHeading = document.createElement('th')
  linkHeading.textContent = 'Link'

  headingRow.append(nameHeading, linkHeading)
  tableHead.appendChild(headingRow)

  const tableBody = document.createElement('tbody')
  const categoryLinks = links[category] ?? []

  for (const item of categoryLinks) {
    const row = document.createElement('tr')
    const nameCell = document.createElement('td')
    nameCell.textContent = item.name
    const linkCell = document.createElement('td')
    const link = document.createElement('a')
    link.href = item.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'Open Link'
    linkCell.appendChild(link)
    row.append(nameCell, linkCell)
    tableBody.appendChild(row)
  }

  table.append(tableHead, tableBody)
  content.appendChild(table)
}

function getDisplayArticles(category, query = '') {
  const normalizedQuery = String(query).trim().toLowerCase()

  return publishedArticles.filter(article => {
    const categoryMatches =
      category === 'ALL' ||
      article.category === category.toLowerCase()
    const searchMatches =
      !normalizedQuery || article.searchText.includes(normalizedQuery)

    return categoryMatches && searchMatches
  })
}

function getCategoryHeading(category, query = '') {
  if (query) {
    return `Search Results for “${query}”`
  }

  if (category === 'TICKETS') {
    return 'Ticket Articles'
  }

  if (category === 'CASHOUTS') {
    return 'Cashout Articles'
  }

  return 'All Published Articles'
}

async function showTicketsTable(
  category,
  { scroll = true, query = '' } = {}
) {
  const ticketSection = document.getElementById('ticketSection')
  const ticketHeader = document.getElementById('ticketHeader')
  const ticketContent = document.getElementById('ticketContent')

  if (!ticketSection || !ticketHeader || !ticketContent) {
    console.error('Knowledge base display elements were not found.')
    return
  }

  const normalizedCategory = String(category)
    .trim()
    .toUpperCase()

  activeCategory = normalizedCategory
  ticketSection.style.display = 'block'
  ticketContent.replaceChildren()

  if (normalizedCategory === 'LINKS') {
    renderLinks(normalizedCategory, ticketHeader, ticketContent)

    if (scroll) {
      ticketSection.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      })
    }

    return
  }

  if (
    normalizedCategory !== 'ALL' &&
    normalizedCategory !== 'TICKETS' &&
    normalizedCategory !== 'CASHOUTS'
  ) {
    ticketHeader.textContent = 'Category unavailable'
    const message = document.createElement('p')
    message.textContent =
      'The selected knowledge base category does not exist.'
    ticketContent.appendChild(message)
    return
  }

  ticketHeader.textContent = 'Loading published articles...'

  try {
    await loadPublishedArticles()
    const articles = getDisplayArticles(normalizedCategory, query)
    ticketHeader.textContent = getCategoryHeading(
      normalizedCategory,
      query
    )
    ticketContent.appendChild(renderArticleGrid(articles))
  } catch (error) {
    console.error('Unable to load knowledge base articles:', error)
    ticketHeader.textContent = 'Unable to load articles'

    const errorMessage = document.createElement('p')
    errorMessage.className = 'load-error'
    errorMessage.textContent =
      `Supabase error: ${error.message || 'Unknown error'}`
    ticketContent.appendChild(errorMessage)
  }

  if (scroll) {
    ticketSection.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }
}

function goToLanding() {
  window.location.href = './index-modular.html'
}

async function handleArticleSearch(query) {
  const requestId = ++searchRequestId
  const normalizedQuery = String(query).trim()

  if (!normalizedQuery) {
    await showTicketsTable(
      activeCategory === 'LINKS' ? 'ALL' : activeCategory,
      { scroll: false }
    )
    return
  }

  try {
    await loadPublishedArticles()

    if (requestId !== searchRequestId) {
      return
    }

    await showTicketsTable('ALL', {
      scroll: false,
      query: normalizedQuery
    })
  } catch (error) {
    console.error('Unable to search knowledge base articles:', error)
  }
}

window.showTicketsTable = showTicketsTable
window.goToLanding = goToLanding

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('searchInput')
  let searchTimer = 0

  searchInput?.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      handleArticleSearch(searchInput.value)
    }, 180)
  })

  showTicketsTable('ALL', { scroll: false })
})
