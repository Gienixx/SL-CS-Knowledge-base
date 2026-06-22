if (!document.getElementById('articlePublishedParserStyles')) {
  const style = document.createElement('style')
  style.id = 'articlePublishedParserStyles'
  style.textContent = `
    .article-body .rich-rules-section,
    .article-body .rich-table-section,
    .article-body .checklist-section,
    .article-body .statement-grid-section {
      margin: 18px 0 4px !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible !important;
    }

    .article-body .rich-rules-section::before,
    .article-body .rich-rules-section::after,
    .article-body .rich-table-section::before,
    .article-body .rich-table-section::after,
    .article-body .checklist-section::before,
    .article-body .checklist-section::after,
    .article-body .statement-grid-section::before,
    .article-body .statement-grid-section::after {
      display: none !important;
      content: none !important;
    }

    .article-body .rich-rules-section > .rich-section-title,
    .article-body .rich-table-section > .rich-section-title,
    .article-body .checklist-section > .rich-section-title,
    .article-body .statement-grid-section > .rich-section-title {
      display: none !important;
    }

    .article-body .rich-rules-section > .rich-intro,
    .article-body .checklist-section > .rich-intro,
    .article-body .statement-grid-section > .rich-intro {
      margin-top: 0 !important;
    }
  `

  document.head.appendChild(style)
}
