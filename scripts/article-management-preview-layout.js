if (!document.getElementById('articleManagementPreviewLayoutStyles')) {
  const style = document.createElement('style')
  style.id = 'articleManagementPreviewLayoutStyles'
  style.textContent = `
    .management-page .management-workspace {
      grid-template-columns:
        minmax(420px, 0.82fr)
        minmax(560px, 1.18fr) !important;
    }

    .management-page .article-preview-panel {
      box-sizing: border-box;
      width: 100%;
      padding: 20px 14px 20px 18px !important;
      overflow-x: hidden;
      scrollbar-gutter: stable;
    }

    .management-page .article-preview-panel .preview-document,
    .management-page .article-preview-panel .preview-body {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: none;
    }

    .management-page .article-preview-panel .preview-body > *,
    .management-page .article-preview-panel .section,
    .management-page .article-preview-panel .step-card,
    .management-page .article-preview-panel .callout-card,
    .management-page .article-preview-panel .response-template-card,
    .management-page .article-preview-panel .nested-rich-unit,
    .management-page .article-preview-panel .rich-table-wrapper {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: 100%;
    }

    .management-page .article-preview-panel img,
    .management-page .article-preview-panel video,
    .management-page .article-preview-panel iframe {
      max-width: 100%;
    }

    @media (max-width: 1180px) {
      .management-page .management-workspace {
        grid-template-columns: minmax(0, 1fr) !important;
      }

      .management-page .article-preview-panel {
        padding: 18px 14px !important;
        scrollbar-gutter: auto;
      }
    }

    @media (max-width: 620px) {
      .management-page {
        padding-right: 10px !important;
        padding-left: 10px !important;
      }

      .management-page .article-preview-panel {
        padding: 16px 10px 16px 14px !important;
        border-radius: 18px;
      }

      .management-page .article-preview-panel .section,
      .management-page .article-preview-panel .step-card,
      .management-page .article-preview-panel .callout-card,
      .management-page .article-preview-panel .response-template-card {
        padding-right: 14px;
        padding-left: 14px;
      }
    }
  `

  document.head.appendChild(style)
}
