import {
  formatArticleUpdateStatus,
  loadArticleUpdateMetadata
} from './article-update-status-utils.js?v=1'

function installStyles() {
  if (document.getElementById('kbArticleUpdateStatusStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'kbArticleUpdateStatusStyles'
  style.textContent = `
    .article-update-status {
      display: block;
      margin-top: 9px;
      color: var(--sl-muted);
      font-size: 0.76rem;
      font-weight: 600;
      line-height: 1.45;
    }
  `
  document.head.appendChild(style)
}

function applyStatuses(metadataById) {
  document.querySelectorAll('.article-card[data-article-id]').forEach(card => {
    const article = metadataById.get(String(card.dataset.articleId))

    if (!article) {
      return
    }

    const content = card.querySelector('.article-content')

    if (!content) {
      return
    }

    let status = content.querySelector('.article-update-status')

    if (!status) {
      status = document.createElement('span')
      status.className = 'article-update-status'
      content.appendChild(status)
    }

    const nextText = formatArticleUpdateStatus(article)

    if (status.textContent !== nextText) {
      status.textContent = nextText
    }
  })
}

async function initialize() {
  installStyles()

  const ticketContent = document.getElementById('ticketContent')

  if (!ticketContent) {
    return
  }

  try {
    const articles = await loadArticleUpdateMetadata({
      publishedOnly: true
    })
    const metadataById = new Map(
      articles.map(article => [String(article.id), article])
    )

    applyStatuses(metadataById)

    const observer = new MutationObserver(() => {
      applyStatuses(metadataById)
    })

    observer.observe(ticketContent, {
      childList: true,
      subtree: true
    })
  } catch (error) {
    console.error('Unable to load article update status:', error)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true })
} else {
  initialize()
}
