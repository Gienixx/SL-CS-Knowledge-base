import {
  setupArticleEditorPreview as setupBasePreview
} from './article-editor-preview.js?v=2'
import {
  parseArticleContent,
  renderArticleUnit
} from './article-content-renderer.js?v=2'
import './article-nesting-styles.js?v=1'

export function setupArticleEditorPreview(options) {
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
