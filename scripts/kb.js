import { supabase } from './supabaseClient.js'
import {
  parseArticleContent,
  renderArticleUnit,
  stripInlineFormatting
} from './article-content-renderer-v8.js?v=3'
import {
  findArticleByRouteValue,
  getArticleHref,
  getArticleRouteValue,
  getArticleSectionIds
} from './article-route.js?v=2'
import './article-nesting-styles.js?v=1'
import './article-published-parser-styles.js?v=1'

const usefulLinks = [
  {
    id: 'demo-compilations',
    category: 'links',
    title: 'Demo Compilations',
    author: 'Support team',
    date: 'Video collection',
    description: 'Recorded demos and walkthroughs of the tools covered throughout the knowledge base.',
    url: 'https://drive.google.com/drive/folders/1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX'
  },
  {
    id: 'meeting-compilations',
    category: 'links',
    title: 'Meeting Compilations',
    author: 'Support team',
    date: 'Video collection',
    description: 'Recorded team meetings and discussions referenced by the support guides.',
    url: 'https://drive.google.com/drive/folders/1nt6ozbXVdq-lhA9MVSXnsm6Bt50Hdrx5?usp=sharing'
  }
]

const categoryLabels = {
  ALL: 'All',
  TICKETS: 'Tickets',
  CASHOUTS: 'Cashouts',
  LINKS: 'Links'
}

let publishedArticles = []
let activeCategory = getInitialCategory()
let requestedArticleRoute = getRequestedArticleRoute()
let selectedId = ''
let searchQuery = ''

const elements = {
  filters: document.getElementById('kbFilters'),
  list: document.getElementById('kbList'),
  detail: document.getElementById('kbDetail'),
  search: document.getElementById('kbSearch'),
  backToTop: document.getElementById('backToTop'),
  referenceDialog: document.getElementById('articleReferenceDialog'),
  referenceCategory: document.getElementById('articleReferenceCategory'),
  referenceTitle: document.getElementById('articleReferenceTitle'),
  referenceSummary: document.getElementById('articleReferenceSummary'),
  referenceClose: document.getElementById('closeArticleReferenceDialog'),
  referenceView: document.getElementById('viewFullArticleReference'),
  referenceNewTab: document.getElementById('openArticleReferenceNewTab')
}

function getInitialCategory() {
  const category = new URLSearchParams(window.location.search).get('category')?.toUpperCase()
  return Object.hasOwn(categoryLabels, category) ? category : 'ALL'
}

function getRequestedArticleRoute() {
  const parameters = new URLSearchParams(window.location.search)

  return (
    parameters.get('article') ||
    parameters.get('id') ||
    ''
  ).trim()
}

function getKnowledgeBaseUrl({
  articleTitle = '',
  category = '',
  section = ''
} = {}) {
  const url = new URL('./KB.html', window.location.href)

  if (articleTitle) {
    url.searchParams.set('article', getArticleRouteValue(articleTitle))
    if (section) url.hash = section
  } else if (category && category !== 'ALL') {
    url.searchParams.set('category', category)
  }

  return `${url.pathname}${url.search}${url.hash}`
}

function updateKnowledgeBaseRoute(options, method = 'pushState') {
  window.history[method](
    options,
    '',
    getKnowledgeBaseUrl(options)
  )
}

function addArticleSectionAnchors(container) {
  const headings = [...container.querySelectorAll('h2, h3')]
  const sectionIds = getArticleSectionIds(
    headings.map(heading => heading.textContent)
  )

  headings.forEach((heading, index) => {
    heading.id = sectionIds[index]
    heading.classList.add('article-section-heading')
  })
}

function scrollToRequestedArticleSection() {
  let sectionId = ''

  try {
    sectionId = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return false
  }

  if (!sectionId) return false
  const section = document.getElementById(sectionId)
  if (!section || !elements.detail.contains(section)) return false

  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'

  window.requestAnimationFrame(() => {
    section.scrollIntoView({ behavior, block: 'start' })
  })
  return true
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall back for browsers that expose Clipboard API but deny this call.
    }
  }

  const temporaryInput = document.createElement('textarea')
  temporaryInput.value = value
  temporaryInput.readOnly = true
  temporaryInput.style.position = 'fixed'
  temporaryInput.style.opacity = '0'
  document.body.appendChild(temporaryInput)
  temporaryInput.select()

  const copied = document.execCommand('copy')
  temporaryInput.remove()

  if (!copied) {
    throw new Error('The browser did not allow clipboard access.')
  }
}

function createCopyArticleLinkButton(article) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'article-copy-button'
  button.setAttribute('aria-label', `Copy link to ${article.title}`)

  const icon = document.createElement('i')
  icon.className = 'ti ti-link'
  icon.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.textContent = 'Copy link'
  button.append(icon, label)

  button.addEventListener('click', async () => {
    const articleUrl = new URL(getArticleHref(article), window.location.href).href
    button.disabled = true

    try {
      await copyTextToClipboard(articleUrl)
      button.dataset.state = 'success'
      icon.className = 'ti ti-check'
      label.textContent = 'Copied'
    } catch (error) {
      console.error('Unable to copy article link:', error)
      button.dataset.state = 'error'
      icon.className = 'ti ti-alert-circle'
      label.textContent = 'Copy failed'
    } finally {
      window.setTimeout(() => {
        button.disabled = false
        delete button.dataset.state
        icon.className = 'ti ti-link'
        label.textContent = 'Copy link'
      }, 1800)
    }
  })

  return button
}

function getInternalArticleReference(link) {
  if (!link?.href) return null

  let url
  try {
    url = new URL(link.href, window.location.href)
  } catch {
    return null
  }

  const knowledgeBaseUrl = new URL('./KB.html', window.location.href)
  if (
    url.origin !== knowledgeBaseUrl.origin ||
    url.pathname.toLowerCase() !== knowledgeBaseUrl.pathname.toLowerCase()
  ) {
    return null
  }

  const routeValue = (
    url.searchParams.get('article') ||
    url.searchParams.get('id') ||
    ''
  ).trim()
  const article = findArticleByRouteValue(publishedArticles, routeValue)

  if (!article) return null

  const canonicalUrl = new URL(getArticleHref(article), window.location.href)
  canonicalUrl.hash = url.hash

  return {
    article,
    href: `${canonicalUrl.pathname}${canonicalUrl.search}${canonicalUrl.hash}`
  }
}

function openArticleReferencePreview(reference) {
  const { article, href } = reference
  const requiredElements = [
    elements.referenceDialog,
    elements.referenceCategory,
    elements.referenceTitle,
    elements.referenceSummary,
    elements.referenceView,
    elements.referenceNewTab
  ]

  if (requiredElements.some(element => !element)) return

  elements.referenceCategory.textContent =
    categoryLabels[article.category.toUpperCase()] || article.category
  elements.referenceTitle.textContent = article.title
  elements.referenceSummary.textContent = stripInlineFormatting(
    article.description
  )
  elements.referenceView.href = href
  elements.referenceNewTab.href = href

  if (!elements.referenceDialog.open) {
    elements.referenceDialog.showModal()
  }
  elements.referenceClose?.focus()
}

function initializeArticleReferencePreview() {
  elements.detail.addEventListener('click', event => {
    const link = event.target.closest('a.article-inline-link')

    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    const reference = getInternalArticleReference(link)
    if (!reference) return

    event.preventDefault()
    openArticleReferencePreview(reference)
  })

  elements.referenceClose?.addEventListener('click', () => {
    elements.referenceDialog?.close()
  })

  elements.referenceNewTab?.addEventListener('click', () => {
    elements.referenceDialog?.close()
  })

  elements.referenceDialog?.addEventListener('click', event => {
    if (event.target === elements.referenceDialog) {
      elements.referenceDialog.close()
    }
  })
}

function missingArticleColumn(error) {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('image_url') ||
    message.includes('updated_at') ||
    message.includes('updated_by_name')
  )
}

async function fetchArticles() {
  let result = await supabase
    .from('articles')
    .select('id, title, description, content, tag, author_name, image_url, created_at, updated_at, updated_by_name')
    .eq('published', true)
    .order('updated_at', { ascending: false })

  if (result.error && missingArticleColumn(result.error)) {
    result = await supabase
      .from('articles')
      .select('id, title, description, content, tag, author_name, created_at')
      .eq('published', true)
      .order('created_at', { ascending: false })
  }

  if (result.error) throw result.error
  return Array.isArray(result.data) ? result.data.map(mapArticle).filter(Boolean) : []
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

function mapArticle(row) {
  const category = String(row.tag || '').trim().toLowerCase()
  if (!['tickets', 'cashouts'].includes(category)) return null

  const rawContent = String(row.content || '')
    .replace(/:::[^\n]*/g, ' ')
    .replace(/[#>*|\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const description = String(row.description || '').trim() ||
    (rawContent
      ? `${rawContent.slice(0, 220)}${rawContent.length > 220 ? '…' : ''}`
      : 'Open this article to read the complete guide.')
  const author = String(row.author_name || '').trim() || 'Support team'
  const updater = String(row.updated_by_name || '').trim() || author
  const date = formatDate(row.updated_at || row.created_at)

  return {
    id: String(row.id),
    category,
    title: String(row.title || '').trim() || 'Untitled Article',
    author,
    updater,
    date,
    description,
    content: String(row.content || '').trim(),
    imageUrl: String(row.image_url || '').trim(),
    url: getArticleHref({ title: row.title }),
    search: `${row.title || ''} ${description} ${row.content || ''} ${author} ${updater} ${category}`.toLowerCase()
  }
}

function itemsForActiveView() {
  const query = searchQuery.trim().toLowerCase()
  const source = activeCategory === 'LINKS'
    ? usefulLinks
    : publishedArticles.filter(article =>
        activeCategory === 'ALL' || article.category === activeCategory.toLowerCase()
      )

  if (!query) return source
  return source.filter(item =>
    (item.search || `${item.title} ${item.description} ${item.author}`).toLowerCase().includes(query)
  )
}

function countForCategory(category) {
  if (category === 'LINKS') return usefulLinks.length
  if (category === 'ALL') return publishedArticles.length
  return publishedArticles.filter(article => article.category === category.toLowerCase()).length
}

function renderFilters() {
  const buttons = Object.entries(categoryLabels).map(([category, label]) => {
    const button = document.createElement('button')
    const isActive = category === activeCategory
    button.type = 'button'
    button.dataset.category = category
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-pressed', String(isActive))
    button.textContent = `${label} (${countForCategory(category)})`
    button.addEventListener('click', () => {
      activeCategory = category
      selectedId = ''
      updateKnowledgeBaseRoute({ category })
      render()
    })
    return button
  })
  elements.filters.replaceChildren(...buttons)
}

function itemMeta(item) {
  if (item.category === 'links') return `${item.author} · ${item.date}`
  return `${item.updater}${item.date ? ` · ${item.date}` : ''}`
}

function scrollToSelectedItem() {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'

  if (window.matchMedia('(max-width: 720px)').matches) {
    elements.detail.scrollIntoView({ behavior, block: 'start' })
    return
  }

  window.scrollTo({ top: 0, behavior })
}

function renderList(items) {
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = searchQuery.trim()
      ? 'No articles match your search.'
      : 'No articles in this category yet.'
    elements.list.replaceChildren(empty)
    return
  }

  const rows = items.map(item => {
    const row = document.createElement('button')
    const isSelected = item.id === selectedId
    row.type = 'button'
    row.className = 'list-item'
    row.classList.toggle('selected', isSelected)
    row.dataset.itemId = item.id
    if (item.category !== 'links') row.dataset.articleId = item.id
    row.setAttribute('aria-pressed', String(isSelected))

    const title = document.createElement('div')
    title.className = 'list-item-title'
    title.textContent = item.title
    const meta = document.createElement('div')
    meta.className = 'list-item-meta'
    meta.textContent = itemMeta(item)
    row.append(title, meta)
    row.addEventListener('click', () => {
      selectedId = item.id

      updateKnowledgeBaseRoute(
        item.category === 'links'
          ? { category: 'LINKS' }
          : { articleTitle: item.title }
      )

      renderList(items)
      renderDetail(item)
      scrollToSelectedItem()
    })
    return row
  })

  elements.list.replaceChildren(...rows)
}

function renderDetail(item) {
  elements.detail.replaceChildren()

  if (!item) {
    const empty = document.createElement('div')
    empty.className = 'empty-state detail-empty'
    empty.textContent = searchQuery.trim()
      ? 'Try another search or category.'
      : 'No article is available in this category yet.'
    elements.detail.append(empty)
    return
  }

  const tag = document.createElement('span')
  tag.className = `tag-pill ${item.category}`
  tag.textContent = categoryLabels[item.category.toUpperCase()]

  const title = document.createElement('h1')
  title.textContent = item.title

  const byline = document.createElement('div')
  byline.className = 'byline'
  const userIcon = document.createElement('i')
  userIcon.className = 'ti ti-user'
  userIcon.setAttribute('aria-hidden', 'true')
  const meta = document.createElement('span')
  meta.textContent = itemMeta(item)
  byline.append(userIcon, meta)

  const body = document.createElement('div')
  body.className = item.category === 'links' ? 'detail-body' : 'article-body'

  if (item.category === 'links') {
    const description = document.createElement('p')
    description.textContent = item.description
    const action = document.createElement('a')
    action.className = 'detail-action'
    action.href = item.url
    action.target = '_blank'
    action.rel = 'noopener noreferrer'
    action.append('Open resource')
    const actionIcon = document.createElement('i')
    actionIcon.className = 'ti ti-external-link'
    actionIcon.setAttribute('aria-hidden', 'true')
    action.append(actionIcon)
    body.append(description, action)
    elements.detail.append(tag, title, byline, body)
    document.title = `${item.title} — Knowledge base`
    return
  }

  const titleRow = document.createElement('div')
  titleRow.className = 'article-title-row'
  titleRow.append(title, createCopyArticleLinkButton(item))

  const detailParts = [tag, titleRow, byline]
  if (item.imageUrl) {
    const cover = document.createElement('img')
    cover.className = 'article-cover'
    cover.src = item.imageUrl
    cover.alt = `${item.title} cover image`
    cover.addEventListener('error', () => cover.remove(), { once: true })
    detailParts.push(cover)
  }

  const dek = document.createElement('p')
  dek.className = 'article-dek'
  dek.textContent = stripInlineFormatting(item.description)
  detailParts.push(dek)

  const units = parseArticleContent(item.content)
  if (units.length) {
    body.append(...units.map(unit => renderArticleUnit(unit)))
  } else {
    const emptyContent = document.createElement('p')
    emptyContent.textContent = item.content || 'This article does not have content yet.'
    body.append(emptyContent)
  }

  addArticleSectionAnchors(body)

  detailParts.push(body)
  elements.detail.append(...detailParts)
  document.title = `${item.title} — Knowledge base`
}

function render() {
  const items = itemsForActiveView()
  if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id || ''
  renderFilters()
  renderList(items)
  renderDetail(items.find(item => item.id === selectedId))
}

function initializeBackToTop() {
  const updateVisibility = () => {
    elements.backToTop.classList.toggle('visible', window.scrollY > 280)
  }
  window.addEventListener('scroll', updateVisibility, { passive: true })
  elements.backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  updateVisibility()
}

document.addEventListener('DOMContentLoaded', async () => {
  initializeBackToTop()
  initializeArticleReferencePreview()
  elements.search.addEventListener('input', () => {
    searchQuery = elements.search.value
    selectedId = ''
    updateKnowledgeBaseRoute({}, 'replaceState')
    render()
  })

  renderFilters()

  try {
    publishedArticles = await fetchArticles()

    const requestedArticle = findArticleByRouteValue(
      publishedArticles,
      requestedArticleRoute
    )

    if (requestedArticle) {
      selectedId = requestedArticle.id
      activeCategory = requestedArticle.category.toUpperCase()
      const canonicalRoute = getArticleRouteValue(requestedArticle.title)
      if (requestedArticleRoute !== canonicalRoute) {
        updateKnowledgeBaseRoute(
          {
            articleTitle: requestedArticle.title,
            section: window.location.hash
          },
          'replaceState'
        )
      }
    } else {
      selectedId = ''
    }

    render()
    scrollToRequestedArticleSection()
  } catch (error) {
    console.error('Unable to load knowledge base articles:', error)
    const message = document.createElement('div')
    message.className = 'empty-state load-error'
    message.textContent = 'Unable to load published articles. Please try again later.'
    elements.list.replaceChildren(message)
    renderDetail(null)
  }
})

window.addEventListener('popstate', () => {
  requestedArticleRoute = getRequestedArticleRoute()
  const requestedArticle = findArticleByRouteValue(
    publishedArticles,
    requestedArticleRoute
  )

  searchQuery = ''
  elements.search.value = ''

  if (requestedArticle) {
    selectedId = requestedArticle.id
    activeCategory = requestedArticle.category.toUpperCase()
    const canonicalRoute = getArticleRouteValue(requestedArticle.title)
    if (requestedArticleRoute !== canonicalRoute) {
      updateKnowledgeBaseRoute(
        {
          articleTitle: requestedArticle.title,
          section: window.location.hash
        },
        'replaceState'
      )
    }
  } else {
    selectedId = ''
    activeCategory = getInitialCategory()
  }

  render()
  scrollToRequestedArticleSection()
})

window.addEventListener('hashchange', scrollToRequestedArticleSection)
