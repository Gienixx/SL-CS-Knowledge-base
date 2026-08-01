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
    id: 'official-links',
    category: 'others',
    title: 'Official Links',
    author: 'CS Operations',
    date: 'Tools and internal resources',
    description: 'Official customer support tools, review portals, recordings, analytics dashboards, and internal resources.',
    groups: [
      {
        title: 'CS Tools',
        links: [
          {
            label: 'Zendesk',
            url: 'https://eurekasurveys.zendesk.com/auth/v3/signin?auth_origin=4417991146772%2Cfalse%2Ctrue&brand_id=4417991146772&locale=1&return_to=https%3A%2F%2Feurekasurveys.zendesk.com%2F&theme=hc'
          },
          { label: 'Admin Tool', url: 'https://admin.eurekasurveys.com/' },
          { label: 'Tremendous', url: 'https://app.tremendous.com/auth/login' },
          { label: 'SendGrid', url: 'https://login.sendgrid.com/login/identifier' },
          { label: 'Twilio Error Message', url: 'https://www.twilio.com/docs/api/errors' },
          {
            label: 'App Demo Recordings',
            url: 'https://drive.google.com/drive/folders/1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX'
          },
          { label: 'iOS Reviews', url: 'https://appstoreconnect.apple.com/login' },
          { label: 'Google Play Reviews', url: 'https://play.google.com/console/developers' },
          {
            label: 'Lucid Marketplace Code',
            url: 'https://support.cint.com/s/article/Marketplace-Response-Codes'
          },
          {
            label: 'Lucid Client Code',
            url: 'https://support.cint.com/s/article/Client-Response-Codes'
          },
          {
            label: 'Cashout MixPanel',
            url: 'https://mixpanel.com/project/2600928/view/3139772/app/boards#id=5212456'
          },
          {
            label: 'Ticket MixPanel',
            url: 'https://mixpanel.com/project/2600928/view/3139772/app/boards#id=9250520'
          },
          {
            label: 'Demo Compilation',
            url: 'https://drive.google.com/drive/folders/1-XRG19rNkVpaG75W9puN3CNiJVJKlQYX'
          },
          {
            label: 'Meeting Compilation',
            url: 'https://drive.google.com/drive/folders/1B7CM5s3Us3YSzmNbDAQdw6My7D_vSev4?usp=drive_link'
          }
        ]
      },
      {
        title: 'CS Internal',
        links: [
          {
            label: 'TimeSheet',
            url: 'https://docs.google.com/spreadsheets/d/1IiFkxAru7GfpZYeO_7soOIEfi2XDjPfOMBcMfC-f7WY/edit?gid=484760849#gid=484760849'
          }
        ]
      }
    ]
  }
]

const categoryLabels = {
  TICKETS: 'Tickets',
  CASHOUTS: 'Cashouts',
  OTHERS: 'Others'
}

let publishedArticles = []
let activeCategory = getInitialCategory()
let expandedCategories = new Set([activeCategory])
let requestedArticleRoute = getRequestedArticleRoute()
let selectedId = ''
let searchQuery = ''

const elements = {
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
  return Object.hasOwn(categoryLabels, category) ? category : 'TICKETS'
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
  } else if (category) {
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

function itemsForCategory(category) {
  const query = searchQuery.trim().toLowerCase()
  const source = category === 'OTHERS'
    ? usefulLinks
    : publishedArticles.filter(
        article => article.category === category.toLowerCase()
      )

  if (!query) return source
  return source.filter(item =>
    [
      item.title,
      item.description,
      item.author,
      ...(item.groups || []).flatMap(group => [
        group.title,
        ...group.links.map(link => `${link.label} ${link.url}`)
      ])
    ].join(' ').toLowerCase().includes(query)
  )
}

function countForCategory(category) {
  if (category === 'OTHERS') return usefulLinks.length
  return publishedArticles.filter(article => article.category === category.toLowerCase()).length
}

function allVisibleItems() {
  return Object.keys(categoryLabels).flatMap(itemsForCategory)
}

function itemMeta(item) {
  if (item.category === 'others') return `${item.author} · ${item.date}`
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

function createArticleListItem(item) {
    const row = document.createElement('button')
    const isSelected = item.id === selectedId
    row.type = 'button'
    row.className = 'list-item'
    row.classList.toggle('selected', isSelected)
    row.dataset.itemId = item.id
    if (item.category !== 'others') row.dataset.articleId = item.id
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
      activeCategory = item.category.toUpperCase()
      expandedCategories.add(activeCategory)

      updateKnowledgeBaseRoute(
        item.category === 'others'
          ? { category: 'OTHERS' }
          : { articleTitle: item.title }
      )

      renderCategoryNavigation()
      renderDetail(item)
      scrollToSelectedItem()
    })
    return row
}

function createCategoryGroup(category, label) {
  const group = document.createElement('section')
  group.className = 'category-group'
  group.dataset.category = category

  const items = itemsForCategory(category)
  const isExpanded = expandedCategories.has(category)
  const panelId = `kbCategory${category}`

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'category-toggle'
  toggle.setAttribute('aria-expanded', String(isExpanded))
  toggle.setAttribute('aria-controls', panelId)

  const chevron = document.createElement('i')
  chevron.className = 'ti ti-chevron-right category-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  const name = document.createElement('span')
  name.className = 'category-name'
  name.textContent = label
  const count = document.createElement('span')
  count.className = 'category-count'
  count.textContent = String(countForCategory(category))
  toggle.append(chevron, name, count)

  const panel = document.createElement('div')
  panel.id = panelId
  panel.className = 'category-items'
  panel.hidden = !isExpanded

  if (items.length) {
    panel.append(...items.map(createArticleListItem))
  } else {
    const empty = document.createElement('div')
    empty.className = 'category-empty'
    empty.textContent = searchQuery.trim()
      ? 'No matching articles.'
      : 'No articles in this category yet.'
    panel.appendChild(empty)
  }

  toggle.addEventListener('click', () => {
    if (expandedCategories.has(category)) {
      expandedCategories.delete(category)
    } else {
      expandedCategories.add(category)
      activeCategory = category
    }
    renderCategoryNavigation()
  })

  group.append(toggle, panel)
  return group
}

function renderCategoryNavigation() {
  const groups = Object.entries(categoryLabels).map(([category, label]) =>
    createCategoryGroup(category, label)
  )

  if (searchQuery.trim() && !allVisibleItems().length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = 'No articles match your search.'
    elements.list.replaceChildren(empty)
    return
  }

  elements.list.replaceChildren(...groups)
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
  body.className = item.category === 'others' ? 'detail-body' : 'article-body'

  if (item.category === 'others') {
    const description = document.createElement('p')
    description.textContent = item.description
    body.appendChild(description)

    for (const groupData of item.groups || []) {
      const group = document.createElement('section')
      group.className = 'official-links-group'
      const heading = document.createElement('h2')
      heading.className = 'official-links-heading'
      heading.textContent = groupData.title
      const list = document.createElement('div')
      list.className = 'official-links-list'

      for (const linkData of groupData.links) {
        const link = document.createElement('a')
        link.className = 'official-link-item'
        link.href = linkData.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        const label = document.createElement('span')
        label.textContent = linkData.label
        const icon = document.createElement('i')
        icon.className = 'ti ti-external-link'
        icon.setAttribute('aria-hidden', 'true')
        link.append(label, icon)
        list.appendChild(link)
      }

      group.append(heading, list)
      body.appendChild(group)
    }

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
  const items = allVisibleItems()
  if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id || ''
  renderCategoryNavigation()
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
    if (searchQuery.trim()) {
      expandedCategories = new Set(
        Object.keys(categoryLabels).filter(
          category => itemsForCategory(category).length
        )
      )
    }
    updateKnowledgeBaseRoute({}, 'replaceState')
    render()
  })

  try {
    publishedArticles = await fetchArticles()

    const requestedArticle = findArticleByRouteValue(
      publishedArticles,
      requestedArticleRoute
    )

    if (requestedArticle) {
      selectedId = requestedArticle.id
      activeCategory = requestedArticle.category.toUpperCase()
      expandedCategories.add(activeCategory)
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
      selectedId =
        itemsForCategory(activeCategory)[0]?.id ||
        allVisibleItems()[0]?.id ||
        ''
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
    expandedCategories.add(activeCategory)
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
    activeCategory = getInitialCategory()
    expandedCategories = new Set([activeCategory])
    selectedId =
      itemsForCategory(activeCategory)[0]?.id ||
      allVisibleItems()[0]?.id ||
      ''
  }

  render()
  scrollToRequestedArticleSection()
})

window.addEventListener('hashchange', scrollToRequestedArticleSection)
