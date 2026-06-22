function appendInlineFormatting(container, text) {
  const value = String(text ?? '')
  const pattern =
    /(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g

  let previousIndex = 0

  for (const match of value.matchAll(pattern)) {
    const matchIndex = match.index ?? 0

    if (matchIndex > previousIndex) {
      container.appendChild(
        document.createTextNode(
          value.slice(previousIndex, matchIndex)
        )
      )
    }

    const formattedText = match[0]

    if (
      formattedText.startsWith('***') &&
      formattedText.endsWith('***')
    ) {
      const strong = document.createElement('strong')
      const emphasis = document.createElement('em')
      emphasis.textContent = formattedText.slice(3, -3)
      strong.appendChild(emphasis)
      container.appendChild(strong)
    } else if (
      formattedText.startsWith('**') &&
      formattedText.endsWith('**')
    ) {
      const strong = document.createElement('strong')
      strong.textContent = formattedText.slice(2, -2)
      container.appendChild(strong)
    } else {
      const emphasis = document.createElement('em')
      emphasis.textContent = formattedText.slice(1, -1)
      container.appendChild(emphasis)
    }

    previousIndex = matchIndex + formattedText.length
  }

  if (previousIndex < value.length) {
    container.appendChild(
      document.createTextNode(value.slice(previousIndex))
    )
  }
}

function parseArticleContent(content) {
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const sections = []
  let currentSection = null
  let currentStep = null
  let paragraphLines = []
  let currentList = null
  let stepNumber = 0

  function activeContainer() {
    return currentStep || currentSection
  }

  function ensureContainer() {
    if (currentStep) {
      return currentStep
    }

    if (!currentSection) {
      currentSection = {
        kind: 'section',
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
      ensureContainer().blocks.push({
        type: 'paragraph',
        text
      })
    }

    paragraphLines = []
  }

  function closeList() {
    currentList = null
  }

  function startSection(title) {
    flushParagraph()
    closeList()
    currentStep = null
    currentSection = {
      kind: 'section',
      title: title.trim() || 'Article Section',
      blocks: []
    }
    sections.push(currentSection)
  }

  function startStep(title) {
    flushParagraph()
    closeList()
    stepNumber += 1
    currentSection = null
    currentStep = {
      kind: 'step',
      stepNumber,
      title: title.trim() || `Step ${stepNumber}`,
      blocks: []
    }
    sections.push(currentStep)
  }

  function addSubheading(text) {
    flushParagraph()
    closeList()
    ensureContainer().blocks.push({
      type: 'subheading',
      text: text.trim()
    })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const stepStartMatch = line.match(/^:::step(?:\s+(.+))?$/i)

    if (!currentStep && stepStartMatch) {
      startStep(stepStartMatch[1] || '')
      continue
    }

    if (currentStep && line === ':::') {
      flushParagraph()
      closeList()
      currentStep = null
      currentSection = null
      continue
    }

    if (!line) {
      flushParagraph()
      closeList()
      continue
    }

    const subheadingMatch = line.match(/^###\s+(.+)$/)

    if (subheadingMatch) {
      addSubheading(subheadingMatch[1])
      continue
    }

    const sectionHeadingMatch = line.match(/^#{1,2}\s+(.+)$/)

    if (sectionHeadingMatch) {
      if (currentStep) {
        addSubheading(sectionHeadingMatch[1])
      } else {
        startSection(sectionHeadingMatch[1])
      }
      continue
    }

    const calloutMatch = line.match(/^>\s*(.+)$/)

    if (calloutMatch) {
      flushParagraph()
      closeList()
      ensureContainer().blocks.push({
        type: 'callout',
        text: calloutMatch[1].trim()
      })
      continue
    }

    const unorderedItemMatch = line.match(/^[-*]\s+(.+)$/)

    if (unorderedItemMatch) {
      flushParagraph()

      if (
        !currentList ||
        currentList.type !== 'unordered-list' ||
        activeContainer()?.blocks.at(-1) !== currentList
      ) {
        currentList = {
          type: 'unordered-list',
          items: []
        }
        ensureContainer().blocks.push(currentList)
      }

      currentList.items.push(unorderedItemMatch[1].trim())
      continue
    }

    const orderedItemMatch = line.match(/^\d+[.)]\s+(.+)$/)

    if (orderedItemMatch) {
      flushParagraph()

      if (
        !currentList ||
        currentList.type !== 'ordered-list' ||
        activeContainer()?.blocks.at(-1) !== currentList
      ) {
        currentList = {
          type: 'ordered-list',
          items: []
        }
        ensureContainer().blocks.push(currentList)
      }

      currentList.items.push(orderedItemMatch[1].trim())
      continue
    }

    closeList()
    paragraphLines.push(line)
  }

  flushParagraph()
  closeList()
  return sections
}

function renderBlock(block) {
  if (block.type === 'subheading') {
    const heading = document.createElement('h4')
    heading.className = 'preview-subheading'
    appendInlineFormatting(heading, block.text)
    return heading
  }

  if (block.type === 'callout') {
    const callout = document.createElement('div')
    callout.className = 'preview-callout'
    appendInlineFormatting(callout, block.text)
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
      const item = document.createElement('li')
      appendInlineFormatting(item, itemText)
      list.appendChild(item)
    }

    return list
  }

  const paragraph = document.createElement('p')
  appendInlineFormatting(paragraph, block.text)
  return paragraph
}

function renderSection(sectionData) {
  const section = document.createElement('section')
  section.className =
    sectionData.kind === 'step'
      ? 'preview-step-card'
      : 'preview-section-card'

  if (sectionData.kind === 'step') {
    const badge = document.createElement('span')
    badge.className = 'preview-step-badge'
    badge.textContent = `Step ${sectionData.stepNumber}`
    section.appendChild(badge)
  }

  const heading = document.createElement('h3')
  heading.className =
    sectionData.kind === 'step'
      ? 'preview-step-title'
      : 'preview-section-title'
  appendInlineFormatting(heading, sectionData.title)
  section.appendChild(heading)

  for (const block of sectionData.blocks) {
    section.appendChild(renderBlock(block))
  }

  return section
}

function installPreviewStyles() {
  if (document.getElementById('articleEditorPreviewStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleEditorPreviewStyles'
  style.textContent = `
    .article-shell {
      max-width: 1500px !important;
    }

    .article-workspace {
      display: grid;
      grid-template-columns: minmax(0, 920px) minmax(360px, 1fr);
      gap: 24px;
      align-items: start;
    }

    .article-workspace > .article-card {
      min-width: 0;
    }

    .article-preview-panel {
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 22px;
      border: 1px solid var(--sl-border);
      border-radius: 22px;
      background:
        linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.97),
          rgba(250, 246, 238, 0.98)
        );
      box-shadow: var(--sl-shadow);
    }

    .preview-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--sl-border);
    }

    .preview-toolbar strong {
      color: var(--sl-navy);
      font-size: 0.9rem;
    }

    .preview-category {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 10px;
      border: 1px solid rgba(255, 194, 26, 0.4);
      border-radius: 999px;
      color: var(--sl-navy);
      background: rgba(255, 194, 26, 0.1);
      font-size: 0.7rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }

    .preview-document {
      min-width: 0;
    }

    .preview-title {
      margin: 0 0 10px;
      color: var(--sl-navy);
      font-size: clamp(1.55rem, 2.2vw, 2.2rem);
      line-height: 1.15;
      overflow-wrap: anywhere;
    }

    .preview-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-bottom: 14px;
      color: var(--sl-muted);
      font-size: 0.78rem;
    }

    .preview-description {
      margin: 0 0 20px;
      color: var(--sl-text);
      font-size: 0.98rem;
      font-weight: 650;
      line-height: 1.55;
    }

    .preview-body {
      display: grid;
      gap: 14px;
    }

    .preview-section-card,
    .preview-step-card {
      padding: 18px;
      border: 1px solid rgba(36, 27, 93, 0.1);
      border-radius: 14px;
      background:
        linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.98),
          rgba(250, 246, 238, 0.96)
        );
      box-shadow: 0 10px 24px rgba(36, 27, 93, 0.05);
    }

    .preview-section-title,
    .preview-step-title,
    .preview-subheading {
      color: var(--sl-navy);
    }

    .preview-section-title,
    .preview-step-title {
      margin: 0 0 10px;
      font-size: 1rem;
      line-height: 1.35;
    }

    .preview-step-badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 9px;
      margin-bottom: 12px;
      border: 1px solid rgba(255, 194, 26, 0.48);
      border-radius: 999px;
      color: var(--sl-navy);
      background: rgba(255, 194, 26, 0.09);
      font-size: 0.64rem;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .preview-subheading {
      margin: 14px 0 7px;
      font-size: 0.9rem;
      line-height: 1.4;
    }

    .preview-section-card p,
    .preview-step-card p,
    .preview-section-card li,
    .preview-step-card li {
      color: var(--sl-muted);
      font-size: 0.88rem;
      line-height: 1.65;
    }

    .preview-section-card p,
    .preview-step-card p {
      margin: 0 0 11px;
    }

    .preview-section-card p:last-child,
    .preview-step-card p:last-child,
    .preview-section-card ul:last-child,
    .preview-step-card ul:last-child,
    .preview-section-card ol:last-child,
    .preview-step-card ol:last-child {
      margin-bottom: 0;
    }

    .preview-section-card strong,
    .preview-step-card strong {
      color: var(--sl-text);
      font-weight: 800;
    }

    .preview-section-card ul,
    .preview-step-card ul,
    .preview-section-card ol,
    .preview-step-card ol {
      margin: 10px 0 12px;
      padding-left: 1.2rem;
    }

    .preview-callout {
      margin: 12px 0;
      padding: 13px 14px;
      border: 1px solid rgba(255, 194, 26, 0.28);
      border-radius: 11px;
      color: var(--sl-text);
      background: rgba(255, 194, 26, 0.08);
      font-size: 0.86rem;
      line-height: 1.55;
    }

    .preview-empty {
      margin: 0;
      padding: 22px 18px;
      border: 1px dashed rgba(36, 27, 93, 0.18);
      border-radius: 13px;
      color: var(--sl-muted);
      text-align: center;
      font-size: 0.86rem;
      line-height: 1.55;
    }

    @media (max-width: 1180px) {
      .article-workspace {
        grid-template-columns: 1fr;
      }

      .article-preview-panel {
        position: relative;
        top: auto;
        max-height: none;
      }
    }
  `

  document.head.appendChild(style)
}

function createAuthorField(form, tagInput) {
  const existingAuthorInput = document.getElementById('author')

  if (existingAuthorInput) {
    return existingAuthorInput
  }

  const tagGroup = tagInput?.closest('.field-group')

  if (!form || !tagGroup) {
    return null
  }

  const group = document.createElement('div')
  group.className = 'field-group'

  const label = document.createElement('label')
  label.className = 'field-label'
  label.htmlFor = 'author'
  label.textContent = 'Author'

  const input = document.createElement('input')
  input.id = 'author'
  input.name = 'author'
  input.type = 'text'
  input.placeholder = 'Enter the article author'
  input.autocomplete = 'name'
  input.maxLength = 120
  input.required = true

  group.append(label, input)
  form.insertBefore(group, tagGroup)
  return input
}

function createPreviewPanel(articleCard) {
  const existingPanel = document.querySelector('.article-preview-panel')

  if (existingPanel) {
    return existingPanel
  }

  const workspace = document.createElement('div')
  workspace.className = 'article-workspace'
  articleCard.parentNode.insertBefore(workspace, articleCard)
  workspace.appendChild(articleCard)

  const panel = document.createElement('aside')
  panel.className = 'article-preview-panel'
  panel.setAttribute('aria-label', 'Live article preview')

  const toolbar = document.createElement('div')
  toolbar.className = 'preview-toolbar'

  const toolbarTitle = document.createElement('strong')
  toolbarTitle.textContent = 'Live Preview'

  const category = document.createElement('span')
  category.id = 'previewCategory'
  category.className = 'preview-category'
  category.textContent = 'No category'

  toolbar.append(toolbarTitle, category)

  const documentElement = document.createElement('article')
  documentElement.className = 'preview-document'

  const title = document.createElement('h2')
  title.id = 'previewTitle'
  title.className = 'preview-title'
  title.textContent = 'Untitled Article'

  const meta = document.createElement('div')
  meta.className = 'preview-meta'

  const author = document.createElement('span')
  author.id = 'previewAuthor'
  author.textContent = 'By: Not specified'

  const status = document.createElement('span')
  status.textContent = 'Draft preview'

  meta.append(author, status)

  const description = document.createElement('p')
  description.id = 'previewDescription'
  description.className = 'preview-description'
  description.textContent =
    'Your article description will appear here.'

  const body = document.createElement('div')
  body.id = 'previewBody'
  body.className = 'preview-body'

  documentElement.append(title, meta, description, body)
  panel.append(toolbar, documentElement)
  workspace.appendChild(panel)
  return panel
}

export function setupArticleEditorPreview({
  form,
  titleInput,
  descriptionInput,
  tagInput,
  contentInput
}) {
  installPreviewStyles()

  const articleCard = form?.closest('.article-card')
  const authorInput = createAuthorField(form, tagInput)
  const previewPanel = articleCard
    ? createPreviewPanel(articleCard)
    : null

  const previewTitle =
    previewPanel?.querySelector('#previewTitle')
  const previewAuthor =
    previewPanel?.querySelector('#previewAuthor')
  const previewDescription =
    previewPanel?.querySelector('#previewDescription')
  const previewCategory =
    previewPanel?.querySelector('#previewCategory')
  const previewBody =
    previewPanel?.querySelector('#previewBody')

  function renderPreview() {
    if (
      !previewTitle ||
      !previewAuthor ||
      !previewDescription ||
      !previewCategory ||
      !previewBody
    ) {
      return
    }

    previewTitle.textContent =
      titleInput?.value.trim() || 'Untitled Article'

    previewAuthor.textContent =
      `By: ${authorInput?.value.trim() || 'Not specified'}`

    const categoryValue = tagInput?.value.trim().toLowerCase()
    previewCategory.textContent =
      categoryValue === 'cashouts'
        ? 'Cashouts'
        : categoryValue === 'tickets'
          ? 'Tickets'
          : 'No category'

    previewDescription.textContent =
      descriptionInput?.value.trim() ||
      'Your article description will appear here.'

    previewBody.replaceChildren()
    const sections = parseArticleContent(contentInput?.value || '')

    if (!sections.length) {
      const empty = document.createElement('p')
      empty.className = 'preview-empty'
      empty.textContent =
        'Start writing article content to see the formatted preview.'
      previewBody.appendChild(empty)
      return
    }

    for (const sectionData of sections) {
      previewBody.appendChild(renderSection(sectionData))
    }
  }

  for (const input of [
    titleInput,
    descriptionInput,
    authorInput,
    tagInput,
    contentInput
  ]) {
    input?.addEventListener('input', renderPreview)
    input?.addEventListener('change', renderPreview)
  }

  renderPreview()

  return {
    authorInput,
    renderPreview
  }
}
