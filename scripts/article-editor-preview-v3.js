import {
  setupArticleEditorPreview as setupBasePreview
} from './article-editor-preview.js?v=2'
import {
  parseArticleContent,
  renderArticleUnit
} from './article-content-renderer-v7.js?v=1'
import './article-nesting-styles.js?v=1'
import './article-preview-parser-styles.js?v=1'
import './article-editor-toolbar-overrides.js?v=1'
import './article-editor-layout-enhancer.js?v=1'

function updateEditorPageLabels() {
  document.title = 'Add Article | SocialLoop CS Base'

  const heading = document.querySelector('.article-title h1')
  const description = document.querySelector('.article-title p')
  const backLink = document.querySelector('.article-topbar .article-link')

  if (heading) {
    heading.textContent = 'Add Article'
  }

  if (description) {
    description.textContent =
      'Create a formatted knowledge base article for the SocialLoop CS Base.'
  }

  if (backLink) {
    backLink.href = './article-management.html'
    backLink.textContent = '← Back to Article Management'
  }
}

export function setupArticleEditorPreview(options) {
  updateEditorPageLabels()

  const basePreview = setupBasePreview(options)
  const previewBody = document.getElementById('previewBody')

  function renderNestedPreview() {
    if (!previewBody) {
      return
    }

    previewBody.replaceChildren()
    const units = parseArticleContent(
      options.contentInput?.value || ''
    )

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

  const inputs = [
    options.titleInput,
    options.descriptionInput,
    options.tagInput,
    options.contentInput,
    document.getElementById('author'),
    document.getElementById('articleImage')
  ]

  for (const input of inputs) {
    input?.addEventListener('input', renderNestedPreview)
    input?.addEventListener('change', renderNestedPreview)
  }

  options.form?.addEventListener('reset', () => {
    queueMicrotask(renderNestedPreview)
  })

  renderNestedPreview()

  return {
    ...basePreview,
    renderPreview() {
      basePreview.renderPreview()
      renderNestedPreview()
    }
  }
}
