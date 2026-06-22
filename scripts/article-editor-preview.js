import {
  parseArticleContent,
  renderArticleUnit
} from './article-content-renderer.js?v=1'

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

    .article-preview-panel .section,
    .article-preview-panel .step-card,
    .article-preview-panel .response-template-card {
      margin: 0;
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
      overflow: hidden;
    }

    .article-preview-panel .section::before,
    .article-preview-panel .section::after {
      display: none;
    }

    .article-preview-panel .rich-section-title,
    .article-preview-panel .step-card-title,
    .article-preview-panel .response-template-title,
    .article-preview-panel .rich-subheading {
      color: var(--sl-navy);
    }

    .article-preview-panel .rich-section-title,
    .article-preview-panel .step-card-title {
      margin: 0 0 10px;
      font-size: 1rem;
      line-height: 1.35;
    }

    .article-preview-panel .step-badge {
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

    .article-preview-panel p,
    .article-preview-panel li,
    .article-preview-panel td {
      color: var(--sl-muted);
      font-size: 0.86rem;
      line-height: 1.62;
    }

    .article-preview-panel p {
      margin: 0 0 11px;
    }

    .article-preview-panel strong {
      color: var(--sl-text);
      font-weight: 800;
    }

    .article-preview-panel ul,
    .article-preview-panel ol {
      margin: 10px 0 12px;
      padding-left: 1.2rem;
    }

    .article-preview-panel .rich-subheading {
      margin: 14px 0 7px;
      font-size: 0.9rem;
      line-height: 1.4;
    }

    .article-preview-panel .rich-callout {
      margin: 12px 0;
      padding: 13px 14px;
      border: 1px solid rgba(255, 194, 26, 0.28);
      border-radius: 11px;
      color: var(--sl-text);
      background: rgba(255, 194, 26, 0.08);
      font-size: 0.86rem;
      line-height: 1.55;
    }

    .article-preview-panel .rich-table-wrapper {
      overflow-x: auto;
      border: 1px solid rgba(36, 27, 93, 0.12);
      border-radius: 12px;
    }

    .article-preview-panel .rich-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 460px;
    }

    .article-preview-panel .rich-table th,
    .article-preview-panel .rich-table td {
      padding: 12px 14px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid rgba(36, 27, 93, 0.09);
    }

    .article-preview-panel .rich-table th {
      color: var(--sl-navy);
      background: rgba(255, 194, 26, 0.1);
      font-size: 0.7rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .article-preview-panel .rich-table tbody tr:last-child td {
      border-bottom: none;
    }

    .article-preview-panel .rule-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .article-preview-panel .rule-card {
      padding: 13px;
      border: 1px solid rgba(36, 27, 93, 0.1);
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.82);
    }

    .article-preview-panel .rule-number {
      display: inline-flex;
      min-width: 20px;
      min-height: 20px;
      align-items: center;
      justify-content: center;
      margin-bottom: 8px;
      border-radius: 6px;
      color: var(--sl-navy);
      background: rgba(255, 194, 26, 0.13);
      font-size: 0.7rem;
      font-weight: 800;
    }

    .article-preview-panel .rule-card p {
      margin: 0;
    }

    .article-preview-panel .response-template-card {
      border-left: 2px solid var(--sl-navy);
      border-top-left-radius: 12px;
      border-bottom-left-radius: 12px;
    }

    .article-preview-panel .response-template-title {
      margin: 0 0 12px;
      font-size: 0.9rem;
      line-height: 1.4;
    }

    .article-preview-panel .checklist-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 16px;
      padding: 0;
      list-style: none;
    }

    .article-preview-panel .checklist-grid li {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 8px;
      margin: 0;
    }

    .article-preview-panel .checklist-mark {
      color: var(--sl-navy);
      font-weight: 900;
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

    @media (max-width: 620px) {
      .article-preview-panel .rule-grid,
      .article-preview-panel .checklist-grid {
        grid-template-columns: 1fr;
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

  const previewTitle = previewPanel?.querySelector('#previewTitle')
  const previewAuthor = previewPanel?.querySelector('#previewAuthor')
  const previewDescription =
    previewPanel?.querySelector('#previewDescription')
  const previewCategory =
    previewPanel?.querySelector('#previewCategory')
  const previewBody = previewPanel?.querySelector('#previewBody')

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
    const units = parseArticleContent(contentInput?.value || '')

    if (!units.length) {
      const empty = document.createElement('p')
      empty.className = 'preview-empty'
      empty.textContent =
        'Start writing article content to see the formatted preview.'
      previewBody.appendChild(empty)
      return
    }

    for (const unit of units) {
      previewBody.appendChild(renderArticleUnit(unit))
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
