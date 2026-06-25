import './article-management-preview-layout.js?v=1'

if (
  window.location.pathname
    .toLowerCase()
    .endsWith('/article-management.html')
) {
  void import('./article-management-update-status.js?v=1').catch(error => {
    console.error('Unable to load article update status:', error)
  })
}

if (!document.getElementById('articlePreviewParserStyles')) {
  const style = document.createElement('style')
  style.id = 'articlePreviewParserStyles'
  style.textContent = `
    .article-preview-panel .rich-rules-section,
    .article-preview-panel .rich-table-section,
    .article-preview-panel .checklist-section,
    .article-preview-panel .statement-grid-section {
      margin: 14px 0 2px !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible !important;
    }

    .article-preview-panel .rich-rules-section::before,
    .article-preview-panel .rich-rules-section::after,
    .article-preview-panel .rich-table-section::before,
    .article-preview-panel .rich-table-section::after,
    .article-preview-panel .checklist-section::before,
    .article-preview-panel .checklist-section::after,
    .article-preview-panel .statement-grid-section::before,
    .article-preview-panel .statement-grid-section::after {
      display: none !important;
      content: none !important;
    }

    .article-preview-panel .rich-rules-section > .rich-section-title,
    .article-preview-panel .rich-table-section > .rich-section-title,
    .article-preview-panel .checklist-section > .rich-section-title,
    .article-preview-panel .statement-grid-section > .rich-section-title {
      display: none !important;
    }

    .article-preview-panel .rich-rules-section > .rich-intro,
    .article-preview-panel .checklist-section > .rich-intro,
    .article-preview-panel .statement-grid-section > .rich-intro {
      margin-top: 0 !important;
    }
  `

  document.head.appendChild(style)
}
