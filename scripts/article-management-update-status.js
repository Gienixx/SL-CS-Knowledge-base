import {
  formatArticleUpdateStatus,
  loadArticleUpdateMetadata
} from './article-update-status-utils.js?v=1'

let metadataById = new Map()
let applyScheduled = false
let reloadScheduled = false

function installStyles() {
  if (document.getElementById('articleManagementUpdateStatusStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleManagementUpdateStatusStyles'
  style.textContent = `
    .article-last-update-status {
      flex-basis: 100%;
      color: var(--sl-muted);
      font-size: 0.78rem;
      font-weight: 650;
      line-height: 1.45;
    }

    .preview-last-update-status {
      flex-basis: 100%;
      color: var(--sl-muted);
      font-size: 0.76rem;
      font-weight: 650;
      line-height: 1.45;
    }
  `
  document.head.appendChild(style)
}

function applyListStatuses() {
  document.querySelectorAll('.article-list-item[data-article-id]').forEach(item => {
    const article = metadataById.get(String(item.dataset.articleId))

    if (!article) {
      return
    }

    const meta = item.querySelector('.article-meta')

    if (!meta) {
      return
    }

    let status = meta.querySelector('.article-last-update-status')

    if (!status) {
      status = document.createElement('span')
      status.className = 'article-last-update-status'
      meta.appendChild(status)
    }

    status.textContent = formatArticleUpdateStatus(article)
  })
}

function applyPreviewStatus() {
  const selectedItem = document.querySelector(
    '.article-list-item.is-selected[data-article-id]'
  )
  const previewMeta = document.querySelector(
    '#articlePreviewPanel .preview-meta'
  )

  if (!previewMeta) {
    return
  }

  let status = document.getElementById('previewLastUpdateStatus')

  if (!selectedItem) {
    status?.remove()
    return
  }

  const article = metadataById.get(String(selectedItem.dataset.articleId))

  if (!article) {
    return
  }

  if (!status) {
    status = document.createElement('span')
    status.id = 'previewLastUpdateStatus'
    status.className = 'preview-last-update-status'
    previewMeta.appendChild(status)
  }

  status.textContent = formatArticleUpdateStatus(article)
}

function applyStatuses() {
  applyScheduled = false
  applyListStatuses()
  applyPreviewStatus()
}

function scheduleApply() {
  if (applyScheduled) {
    return
  }

  applyScheduled = true
  queueMicrotask(applyStatuses)
}

async function reloadMetadata() {
  reloadScheduled = false

  try {
    const articles = await loadArticleUpdateMetadata()
    metadataById = new Map(
      articles.map(article => [String(article.id), article])
    )
    scheduleApply()
  } catch (error) {
    console.error('Unable to load article-management update status:', error)
  }
}

function scheduleReload(delay = 350) {
  if (reloadScheduled) {
    return
  }

  reloadScheduled = true
  window.setTimeout(reloadMetadata, delay)
}

function initialize() {
  installStyles()

  const articleList = document.getElementById('articleList')
  const previewPanel = document.getElementById('articlePreviewPanel')
  const refreshButton = document.getElementById('refreshArticlesButton')

  if (!articleList || !previewPanel) {
    return
  }

  const observer = new MutationObserver(mutations => {
    const containsUnknownArticle = mutations.some(() =>
      Array.from(
        document.querySelectorAll('.article-list-item[data-article-id]')
      ).some(item => !metadataById.has(String(item.dataset.articleId)))
    )

    if (containsUnknownArticle) {
      scheduleReload()
    } else {
      scheduleApply()
    }
  })

  observer.observe(articleList, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  })

  observer.observe(previewPanel, {
    childList: true,
    subtree: true
  })

  refreshButton?.addEventListener('click', () => {
    scheduleReload(600)
  })

  reloadMetadata()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true })
} else {
  initialize()
}
