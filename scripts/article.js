import { supabase } from './supabaseClient.js'
import {
  createExcerpt,
  parseArticleContent,
  renderArticleUnit,
  stripInlineFormatting
} from './article-content-renderer-v7.js?v=1'
import './article-nesting-styles.js?v=1'
import './article-published-parser-styles.js?v=1'

const titleElement = document.getElementById('articleTitle')
const dateElement = document.getElementById('articleDate')
const authorElement = document.getElementById('articleAuthor')
const dekElement = document.getElementById('articleDek')
const ghostTitleElement = document.getElementById('ghostTitle')
const loadingSection = document.getElementById('loadingSection')
const errorSection = document.getElementById('errorSection')
const errorElement = document.getElementById('articleError')
const contentGrid = document.getElementById('contentGrid')
const tocLinks = document.getElementById('tocLinks')
const articleBody = document.getElementById('articleBody')
const footerNote = document.getElementById('footerNote')

function requiredElementsExist() {
  return Boolean(
    titleElement &&
    dateElement &&
    authorElement &&
    dekElement &&
    ghostTitleElement &&
    loadingSection &&
    errorSection &&
    errorElement &&
    contentGrid &&
    tocLinks &&
    articleBody &&
    footerNote
  )
}

function getErrorMessage(error) {
  if (error && typeof error.message === 'string') {
    return error.message
  }

  return 'An unexpected error occurred.'
}

function getUnitLabel(unit) {
  if (unit.kind === 'step') {
    return `Step ${unit.stepNumber}: ${unit.title}`
  }

  if (unit.kind === 'table') {
    return unit.title || 'Decision Table'
  }

  if (unit.kind === 'callout') {
    return unit.title || 'Important Note'
  }

  return unit.title || 'Article Section'
}

function createUniqueSectionId(title, index, usedIds) {
  const baseId =
    stripInlineFormatting(title)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
    `section-${index + 1}`

  let id = baseId
  let suffix = 2

  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }

  usedIds.add(id)
  return id
}

function renderTableOfContents(units) {
  tocLinks.replaceChildren()
  const usedIds = new Set()

  units.forEach((unit, index) => {
    const label = getUnitLabel(unit)
    unit.id = createUniqueSectionId(label, index, usedIds)

    const link = document.createElement('a')
    link.href = `#${unit.id}`
    link.textContent = stripInlineFormatting(label)
    tocLinks.appendChild(link)
  })
}

function renderUnits(units) {
  articleBody.replaceChildren()

  for (const unit of units) {
    const element = renderArticleUnit(unit)
    element.id = unit.id
    articleBody.appendChild(element)
  }
}

function formatArticleDate(createdAt) {
  if (!createdAt) {
    return 'Published Article'
  }

  const date = new Date(createdAt)

  if (Number.isNaN(date.getTime())) {
    return 'Published Article'
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

function renderArticle(article) {
  const title =
    String(article.title ?? '').trim() ||
    'Untitled Article'
  const description = String(article.description ?? '').trim()
  const content = String(article.content ?? '').trim()
  const normalizedTag = String(article.tag ?? '')
    .trim()
    .toLowerCase()
  const category =
    normalizedTag === 'cashouts' ? 'Cashout' : 'Ticket'
  const units = parseArticleContent(content)
  const excerpt = description
    ? stripInlineFormatting(description)
    : createExcerpt(units, content)

  document.title = `${title} | SocialLoop CS Base`
  titleElement.textContent = title
  ghostTitleElement.textContent =
    `${category}\nSupport Article`
  dateElement.textContent = formatArticleDate(
    article.created_at
  )
  authorElement.textContent = article.author_name
    ? `By: ${article.author_name}`
    : 'SocialLoop Customer Support'
  dekElement.textContent =
    excerpt || `${category} knowledge base article`

  renderTableOfContents(units)
  renderUnits(units)

  loadingSection.hidden = true
  errorSection.hidden = true
  contentGrid.hidden = false
  footerNote.hidden = false
}

function showError(messageText) {
  if (!requiredElementsExist()) {
    console.error(messageText)
    return
  }

  document.title =
    'Article unavailable | SocialLoop CS Base'
  titleElement.textContent = 'Article unavailable'
  dateElement.textContent = 'Unavailable'
  authorElement.textContent = ''
  dekElement.textContent =
    'This knowledge base article cannot be displayed.'
  loadingSection.hidden = true
  contentGrid.hidden = true
  footerNote.hidden = true
  errorElement.textContent = messageText
  errorSection.hidden = false
}

async function loadArticle() {
  if (!requiredElementsExist()) {
    console.error(
      'Required article display elements were not found.'
    )
    return
  }

  const articleId = new URLSearchParams(
    window.location.search
  ).get('id')

  if (!articleId) {
    showError('No article was selected.')
    return
  }

  try {
    const {
      data: article,
      error
    } = await supabase
      .from('articles')
      .select(`
        title,
        description,
        content,
        tag,
        author_name,
        created_at,
        published
      `)
      .eq('id', articleId)
      .eq('published', true)
      .maybeSingle()

    if (error) {
      throw error
    }

    if (!article) {
      showError(
        'The requested article could not be found or is not published.'
      )
      return
    }

    renderArticle(article)
  } catch (error) {
    console.error('Article loading error:', error)
    showError(
      `Unable to load article: ${getErrorMessage(error)}`
    )
  }
}

loadArticle()
