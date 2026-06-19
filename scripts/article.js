import { supabase } from './supabaseClient.js'

const titleElement =
  document.getElementById('articleTitle')

const dateElement =
  document.getElementById('articleDate')

const authorElement =
  document.getElementById('articleAuthor')

const dekElement =
  document.getElementById('articleDek')

const ghostTitleElement =
  document.getElementById('ghostTitle')

const loadingSection =
  document.getElementById('loadingSection')

const errorSection =
  document.getElementById('errorSection')

const errorElement =
  document.getElementById('articleError')

const contentGrid =
  document.getElementById('contentGrid')

const tocLinks =
  document.getElementById('tocLinks')

const articleBody =
  document.getElementById('articleBody')

const footerNote =
  document.getElementById('footerNote')

async function loadArticle() {
  const articleId =
    new URLSearchParams(window.location.search).get('id')

  if (!articleId) {
    showError('No article was selected.')
    return
  }

  const {
    data: article,
    error
  } = await supabase
    .from('articles')
    .select(`
      title,
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

  renderArticle(article)
}

function renderArticle(article) {
  const title =
    String(article.title ?? '').trim() ||
    'Untitled Article'

  const content =
    String(article.content ?? '').trim()

  const normalizedTag =
    String(article.tag ?? '')
      .trim()
      .toLowerCase()

  const category =
    normalizedTag === 'cashouts'
      ? 'Cashout'
      : 'Ticket'

  const sections = parseArticleContent(content)
  const excerpt = createExcerpt(sections, content)

  document.title =
    `${title} | SocialLoop CS Base`

  titleElement.textContent = title

  ghostTitleElement.textContent =
    `${category}\nSupport Article`

  dateElement.textContent =
    formatArticleDate(article.created_at)

  authorElement.textContent =
    article.author_name
      ? `By: ${article.author_name}`
      : 'SocialLoop Customer Support'

  dekElement.textContent =
    excerpt ||
    `${category} knowledge base article`

  renderTableOfContents(sections)
  renderSections(sections)

  loadingSection.hidden = true
  errorSection.hidden = true
  contentGrid.hidden = false
  footerNote.hidden = false
}

function parseArticleContent(content) {
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const sections = []
  let currentSection = null
  let paragraphLines = []
  let currentList = null

  function ensureSection() {
    if (!currentSection) {
      currentSection = {
        title: 'Overview',
        blocks: []
      }

      sections.push(currentSection)
    }

    return currentSection
  }

  function flushParagraph() {
    const text = paragraphLines
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (text) {
      ensureSection().blocks.push({
        type: 'paragraph',
        text
      })
    }

    paragraphLines = []
  }

  function flushList() {
    currentList = null
  }

  function startSection(title) {
    flushParagraph()
    flushList()

    currentSection = {
      title: title.trim() || 'Article Section',
      blocks: []
    }

    sections.push(currentSection)
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      flushList()
      continue
    }

    const mainHeading =
      line.match(/^#{1,2}\s+(.+)$/)

    if (mainHeading) {
      startSection(mainHeading[1])
      continue
    }

    const subheading =
      line.match(/^###\s+(.+)$/)

    if (subheading) {
      flushParagraph()
      flushList()

      ensureSection().blocks.push({
        type: 'subheading',
        text: subheading[1].trim()
      })

      continue
    }

    const callout =
      line.match(/^>\s*(.+)$/)

    if (callout) {
      flushParagraph()
      flushList()

      ensureSection().blocks.push({
        type: 'callout',
        text: callout[1].trim()
      })

      continue
    }

    const unorderedItem =
      line.match(/^[-*]\s+(.+)$/)

    if (unorderedItem) {
      flushParagraph()

      if (!currentList || currentList.type !== 'unordered-list') {
        currentList = {
          type: 'unordered-list',
          items: []
        }

        ensureSection().blocks.push(currentList)
      }

      currentList.items.push(
        unorderedItem[1].trim()
      )

      continue
    }

    const orderedItem =
      line.match(/^\d+[.)]\s+(.+)$/)

    if (orderedItem) {
      flushParagraph()

      if (!currentList || currentList.type !== 'ordered-list') {
        currentList = {
          type: 'ordered-list',
          items: []
        }

        ensureSection().blocks.push(currentList)
      }

      currentList.items.push(
        orderedItem[1].trim()
      )

      continue
    }

    flushList()
    paragraphLines.push(line)
  }

  flushParagraph()
  flushList()

  if (!sections.length) {
    sections.push({
      title: 'Article Content',
      blocks: [
        {
          type: 'paragraph',
          text: 'No article content is available.'
        }
      ]
    })
  }

  return sections.filter(section => {
    return (
      section.title ||
      section.blocks.length > 0
    )
  })
}

function createExcerpt(sections, rawContent) {
  for (const section of sections) {
    for (const block of section.blocks) {
      if (
        block.type === 'paragraph' ||
        block.type === 'callout'
      ) {
        return shortenText(block.text, 180)
      }

      if (
        block.type === 'unordered-list' ||
        block.type === 'ordered-list'
      ) {
        const firstItem = block.items[0]

        if (firstItem) {
          return shortenText(firstItem, 180)
        }
      }
    }
  }

  return shortenText(
    String(rawContent ?? '')
      .replace(/[#>*-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    180
  )
}

function shortenText(text, maximumLength) {
  const normalized =
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return (
    normalized
      .slice(0, maximumLength)
      .trim() +
    '…'
  )
}

function renderTableOfContents(sections) {
  tocLinks.replaceChildren()

  const usedIds = new Set()

  sections.forEach((section, index) => {
    const id = createUniqueSectionId(
      section.title,
      index,
      usedIds
    )

    section.id = id

    const link = document.createElement('a')
    link.href = `#${id}`
    link.textContent = section.title

    tocLinks.appendChild(link)
  })
}

function renderSections(sections) {
  articleBody.replaceChildren()

  for (const sectionData of sections) {
    const section =
      document.createElement('section')

    section.id = sectionData.id
    section.className = 'section'

    const heading =
      document.createElement('h2')

    heading.textContent = sectionData.title

    section.appendChild(heading)

    if (!sectionData.blocks.length) {
      const emptyParagraph =
        document.createElement('p')

      emptyParagraph.textContent =
        'No additional information was provided.'

      section.appendChild(emptyParagraph)
    }

    for (const block of sectionData.blocks) {
      section.appendChild(
        renderContentBlock(block)
      )
    }

    articleBody.appendChild(section)
  }
}

function renderContentBlock(block) {
  if (block.type === 'subheading') {
    const heading =
      document.createElement('h3')

    heading.textContent = block.text

    return heading
  }

  if (block.type === 'callout') {
    const callout =
      document.createElement('div')

    callout.className = 'callout'
    callout.textContent = block.text

    return callout
  }

  if (
    block.type === 'unordered-list' ||
    block.type === 'ordered-list'
  ) {
    const list =
      block.type === 'ordered-list'
        ? document.createElement('ol')
        : document.createElement('ul')

    for (const itemText of block.items) {
      const item =
        document.createElement('li')

      item.textContent = itemText
      list.appendChild(item)
    }

    return list
  }

  const paragraph =
    document.createElement('p')

  paragraph.textContent = block.text

  return paragraph
}

function createUniqueSectionId(
  title,
  index,
  usedIds
) {
  const baseId =
    String(title ?? '')
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

function formatArticleDate(createdAt) {
  if (!createdAt) {
    return 'Published Article'
  }

  const date = new Date(createdAt)

  if (Number.isNaN(date.getTime())) {
    return 'Published Article'
  }

  return new Intl.DateTimeFormat(
    'en-US',
    {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }
  ).format(date)
}

function showError(message) {
  titleElement.textContent =
    'Article unavailable'

  dateElement.textContent =
    'Unavailable'

  authorElement.textContent = ''

  dekElement.textContent =
    'This knowledge base article cannot be displayed.'

  loadingSection.hidden = true
  contentGrid.hidden = true
  footerNote.hidden = true

  errorElement.textContent = message
  errorSection.hidden = false
}

loadArticle()
