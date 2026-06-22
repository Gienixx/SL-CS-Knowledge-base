if (!document.getElementById('articleManagementPreviewLayoutStyles')) {
  const style = document.createElement('style')
  style.id = 'articleManagementPreviewLayoutStyles'
  style.textContent = `
    .management-workspace {
      grid-template-columns:
        minmax(420px, 0.82fr)
        minmax(560px, 1.18fr) !important;
    }

    .article-preview-panel {
      box-sizing: border-box;
      width: 100%;
      padding: 20px 14px 20px 18px !important;
      overflow-x: hidden;
      scrollbar-gutter: stable;
    }

    .article-preview-panel .preview-document,
    .article-preview-panel .preview-body {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: none;
    }

    .article-preview-panel .preview-body > *,
    .article-preview-panel .section,
    .article-preview-panel .step-card,
    .article-preview-panel .callout-card,
    .article-preview-panel .response-template-card,
    .article-preview-panel .nested-rich-unit,
    .article-preview-panel .rich-table-wrapper {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: 100%;
    }

    .article-preview-panel img,
    .article-preview-panel video,
    .article-preview-panel iframe {
      max-width: 100%;
    }

    @media (max-width: 1180px) {
      .management-workspace {
        grid-template-columns: minmax(0, 1fr) !important;
      }

      .article-preview-panel {
        padding: 18px 14px !important;
        scrollbar-gutter: auto;
      }
    }

    @media (max-width: 620px) {
      .management-page {
        padding-right: 10px !important;
        padding-left: 10px !important;
      }

      .article-preview-panel {
        padding: 16px 10px 16px 14px !important;
        border-radius: 18px;
      }

      .article-preview-panel .section,
      .article-preview-panel .step-card,
      .article-preview-panel .callout-card,
      .article-preview-panel .response-template-card {
        padding-right: 14px;
        padding-left: 14px;
      }
    }
  `

  document.head.appendChild(style)
}
