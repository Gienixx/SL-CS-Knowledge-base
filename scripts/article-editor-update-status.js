import {
  formatArticleUpdateDate,
  formatArticleUpdateStatus,
  getCurrentArticleManager,
  loadArticleUpdateMetadata
} from './article-update-status-utils.js?v=1'

let manager = null
let articleId = ''

function installStyles() {
  if (document.getElementById('articleEditorUpdateStatusStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleEditorUpdateStatusStyles'
  style.textContent = `
    .editor-preview-update-status {
      flex-basis: 100%;
      color: var(--sl-muted);
      font-size: 0.76rem;
      font-weight: 650;
      line-height: 1.45;
    }
  `
  document.head.appendChild(style)
}

function getStatusElement() {
  const previewMeta = document.querySelector(
    '.article-preview-panel .preview-meta'
  )

  if (!previewMeta) {
    return null
  }

  let status = document.getElementById('editorPreviewUpdateStatus')

  if (!status) {
    status = document.createElement('span')
    status.id = 'editorPreviewUpdateStatus'
    status.className = 'editor-preview-update-status'
    previewMeta.appendChild(status)
  }

  return status
}

async function renderStoredStatus() {
  const status = getStatusElement()

  if (!status) {
    return
  }

  if (!articleId) {
    status.textContent = manager?.displayName
      ? `New article · Changes will be recorded as ${manager.displayName}`
      : 'New article · Update history begins after saving'
    return
  }

  const article = await loadArticleUpdateMetadata({ articleId })

  status.textContent = article
    ? formatArticleUpdateStatus(article)
    : 'Update history unavailable'
}

function renderJustSavedStatus() {
  const status = getStatusElement()

  if (!status) {
    return
  }

  const updater = manager?.displayName || 'Current user'
  status.textContent =
    `Last updated by ${updater} · ` +
    formatArticleUpdateDate(new Date().toISOString())
}

function watchSaveStatus() {
  const message = document.getElementById('message')

  if (!message) {
    return
  }

  const observer = new MutationObserver(() => {
    const text = message.textContent.trim().toLowerCase()

    if (
      text === 'article updated successfully.' ||
      text === 'article saved successfully.'
    ) {
      if (articleId) {
        window.setTimeout(() => {
          renderStoredStatus().catch(error => {
            console.error('Unable to refresh article update status:', error)
            renderJustSavedStatus()
          })
        }, 300)
      } else {
        renderJustSavedStatus()
      }
    }
  })

  observer.observe(message, {
    childList: true,
    subtree: true,
    characterData: true
  })
}

async function initialize() {
  installStyles()
  articleId = new URLSearchParams(window.location.search).get('edit') || ''

  try {
    manager = await getCurrentArticleManager()
    await renderStoredStatus()
    watchSaveStatus()
  } catch (error) {
    console.error('Unable to initialize editor update status:', error)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true })
} else {
  initialize()
}
