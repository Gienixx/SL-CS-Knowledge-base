import {
  formatArticleUpdateStatus,
  getCurrentArticleManager,
  loadArticleUpdateMetadata
} from './article-update-status-utils.js?v=1'

function installStyles() {
  if (document.getElementById('articlePageUpdateStatusStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articlePageUpdateStatusStyles'
  style.textContent = `
    .published-article-update-status {
      flex-basis: 100%;
      color: var(--muted);
      font-size: 0.86rem;
      font-weight: 650;
      line-height: 1.45;
    }

    .article-management-return-link {
      display: inline-flex;
      min-height: 36px;
      align-items: center;
      justify-content: center;
      padding: 0 15px;
      border: 1px solid rgba(255, 194, 26, 0.52);
      border-radius: 999px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.9);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 750;
      white-space: nowrap;
    }

    .article-management-return-link:hover {
      border-color: rgba(255, 194, 26, 0.82);
      background: rgba(255, 194, 26, 0.12);
    }
  `
  document.head.appendChild(style)
}

function renderUpdateStatus(article) {
  const meta = document.querySelector('.article-head .meta')

  if (!meta || !article) {
    return
  }

  let status = document.getElementById('publishedArticleUpdateStatus')

  if (!status) {
    status = document.createElement('span')
    status.id = 'publishedArticleUpdateStatus'
    status.className = 'published-article-update-status'
    meta.appendChild(status)
  }

  status.textContent = formatArticleUpdateStatus(article)
}

function renderManagementLink(canManageArticles) {
  const navShell = document.querySelector('.nav-shell')

  if (!navShell) {
    return
  }

  const existingLink = document.getElementById('articleManagementReturnLink')

  if (!canManageArticles) {
    existingLink?.remove()
    return
  }

  if (existingLink) {
    return
  }

  const link = document.createElement('a')
  link.id = 'articleManagementReturnLink'
  link.className = 'article-management-return-link'
  link.href = './article-management.html'
  link.textContent = '← Back to Article Management'
  navShell.appendChild(link)
}

async function initialize() {
  installStyles()

  const articleId = new URLSearchParams(window.location.search).get('id')

  if (!articleId) {
    return
  }

  try {
    const article = await loadArticleUpdateMetadata({
      articleId,
      publishedOnly: true
    })

    renderUpdateStatus(article)
  } catch (error) {
    console.error('Unable to load article update status:', error)
  }

  try {
    const manager = await getCurrentArticleManager()
    renderManagementLink(manager.canManageArticles)
  } catch (error) {
    console.error('Unable to load article management access:', error)
    renderManagementLink(false)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true })
} else {
  initialize()
}
