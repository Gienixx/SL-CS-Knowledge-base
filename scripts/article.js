import { supabase } from './supabaseClient.js'
import {
  createExcerpt,
  parseArticleContent,
  renderArticleUnit,
  stripInlineFormatting
} from './article-content-renderer.js?v=1'

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

function installRichContentStyles() {
  if (document.getElementById('articleRichContentStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleRichContentStyles'
  style.textContent = `
    .step-card,
    .response-template-card {
      position: relative;
      margin-bottom: 18px;
      padding: 24px 26px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background:
        linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.98),
          rgba(250, 246, 238, 0.96)
        );
      box-shadow: 0 14px 36px rgba(36, 27, 93, 0.07);
      scroll-margin-top: 90px;
    }

    .step-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 26px;
      padding: 4px 10px;
      border: 1px solid rgba(255, 194, 26, 0.48);
      border-radius: 999px;
      color: var(--text);
      background: rgba(255, 194, 26, 0.09);
      font-size: 0.68rem;
      font-weight: 850;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .step-card-title {
      margin: 14px 0 10px;
      color: var(--text);
      font-size: 1.06rem;
      line-height: 1.35;
    }

    .step-card p,
    .step-card li,
    .response-template-card p,
    .response-template-card li {
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.74;
    }

    .rich-table-wrapper {
      overflow-x: auto;
      border: 1px solid rgba(36, 27, 93, 0.12);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.92);
    }

    .rich-table {
      width: 100%;
      min-width: 560px;
      border-collapse: collapse;
    }

    .rich-table th,
    .rich-table td {
      padding: 18px 20px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid rgba(36, 27, 93, 0.09);
    }

    .rich-table th {
      color: var(--text);
      background: rgba(255, 194, 26, 0.1);
      font-size: 0.74rem;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .rich-table td {
      color: var(--muted);
      font-size: 0.96rem;
      line-height: 1.6;
    }

    .rich-table tbody tr:last-child td {
      border-bottom: none;
    }

    .rich-intro {
      margin-bottom: 18px !important;
    }

    .rule-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .rule-card {
      min-height: 126px;
      padding: 16px;
      border: 1px solid rgba(36, 27, 93, 0.11);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.82);
    }

    .rule-number {
      display: inline-flex;
      min-width: 21px;
      min-height: 21px;
      align-items: center;
      justify-content: center;
      margin-bottom: 10px;
      border-radius: 6px;
      color: var(--text);
      background: rgba(255, 194, 26, 0.14);
      font-size: 0.72rem;
      font-weight: 850;
    }

    .rule-card p {
      margin: 0;
      color: var(--muted);
      font-size: 0.94rem;
      line-height: 1.65;
    }

    .response-template-card {
      border-left: 2px solid var(--text);
      border-top-left-radius: 12px;
      border-bottom-left-radius: 12px;
    }

    .response-template-title {
      margin: 0 0 14px;
      color: var(--text);
      font-size: 0.98rem;
      line-height: 1.4;
    }

    .response-template-card p {
      margin: 0 0 16px;
    }

    .response-template-card p:last-child {
      margin-bottom: 0;
    }

    .checklist-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 26px;
      padding: 0 !important;
      margin: 14px 0 0 !important;
      list-style: none;
    }

    .checklist-grid li {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 9px;
      margin: 0 !important;
    }

    .checklist-mark {
      color: var(--text);
      font-size: 1rem;
      font-weight: 900;
    }

    .rich-subheading {
      margin-top: 18px;
    }

    @media (max-width: 620px) {
      .rule-grid,
      .checklist-grid {
        grid-template-columns: 1fr;
      }

      .step-card,
      .response-template-card {
        padding: 20px 18px;
      }
    }
  `

  document.head.appendChild(style)
}

function getUnitLabel(unit) {
  if (unit.kind === 'step') {
    return `Step ${unit.stepNumber}: ${unit.title}`
  }

  if (unit.kind === 'table') {
    return unit.title || 'Decision Table'
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
  ghostTitleElement.textContent = `${category}\nSupport Article`
  dateElement.textContent = formatArticleDate(article.created_at)
  authorElement.textContent = article.author_name
    ? `By: ${article.author_name}`
    : 'SocialLoop Customer Support'
  dekElement.textContent =
    excerpt || `${category} knowledge base article`

  installRichContentStyles()
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
