import './edit-article.js?v=1'
import './edit-article-image-preview.js?v=1'
import {
  setupArticleEditorHistory
} from './article-editor-history.js?v=1'
import {
  setupArticleBlockLayout
} from './article-editor-block-layout.js?v=1'
import {
  addArticleLayoutControls
} from './article-editor-layout-controls.js?v=1'
import {
  setupGenericArticleFormats
} from './article-editor-generic-formats.js?v=1'

function initializeLayoutEnhancements() {
  const contentInput = document.getElementById('content')
  const toolbar = document.querySelector('.format-toolbar')

  if (!contentInput || !toolbar) {
    return false
  }

  if (!toolbar.classList.contains('grouped-toolbar')) {
    return false
  }

  if (contentInput.dataset.layoutEnhancementsReady === 'true') {
    return true
  }

  const history = setupArticleEditorHistory(contentInput)
  const blockLayout = setupArticleBlockLayout(contentInput)

  addArticleLayoutControls(toolbar)
  setupGenericArticleFormats({
    toolbar,
    input: contentInput
  })

  const handledFormats = new Set([
    'align-left',
    'align-center',
    'align-right',
    'align-justify',
    'increase-indent',
    'decrease-indent'
  ])

  toolbar.addEventListener(
    'click',
    event => {
      const formatButton = event.target.closest('[data-format]')
      const format = formatButton?.dataset.format

      if (!formatButton || !handledFormats.has(format)) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()

      if (format.startsWith('align-')) {
        blockLayout.align(format.slice('align-'.length))
      } else if (format === 'increase-indent') {
        blockLayout.increaseIndent()
      } else {
        blockLayout.decreaseIndent()
      }

      toolbar.querySelectorAll('.toolbar-menu[open]').forEach(menu => {
        menu.removeAttribute('open')
      })
    },
    true
  )

  const help = document.querySelector('.format-help')

  if (help && !help.querySelector('[data-layout-help]')) {
    const helpText = document.createElement('span')
    helpText.dataset.layoutHelp = 'true'
    helpText.textContent =
      ' Ctrl/Cmd+Z undoes edits, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes them. Alignment and indentation are preserved in the published article.'
    help.appendChild(helpText)
  }

  contentInput.dataset.layoutEnhancementsReady = 'true'
  window.articleEditorHistory = history
  return true
}

function scheduleInitialization(attempt = 0) {
  if (initializeLayoutEnhancements()) {
    return
  }

  if (attempt >= 20) {
    console.warn('Unable to initialize article layout controls.')
    return
  }

  window.setTimeout(() => {
    scheduleInitialization(attempt + 1)
  }, 50)
}

queueMicrotask(() => scheduleInitialization())
