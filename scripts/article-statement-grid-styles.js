if (!document.getElementById('articleStatementGridStyles')) {
  const style = document.createElement('style')
  style.id = 'articleStatementGridStyles'
  style.textContent = `
    .statement-grid-section {
      overflow: hidden;
    }

    .statement-grid-title {
      margin-bottom: 10px;
    }

    .statement-grid-intro {
      margin-bottom: 18px !important;
    }

    .statement-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .statement-card {
      min-height: 74px;
      display: flex;
      align-items: center;
      padding: 16px;
      border: 1px solid rgba(36, 27, 93, 0.12);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow: 0 6px 18px rgba(36, 27, 93, 0.035);
    }

    .statement-card p {
      margin: 0 !important;
      color: var(--muted, var(--sl-muted, #6f678f));
      font-size: 0.94rem;
      line-height: 1.6;
    }

    .statement-card strong {
      color: var(--text, var(--sl-text, #2b2459));
      font-weight: 800;
    }

    .article-preview-panel .statement-grid {
      gap: 10px;
    }

    .article-preview-panel .statement-card {
      min-height: 66px;
      padding: 13px;
      border-radius: 10px;
    }

    .article-preview-panel .statement-card p {
      font-size: 0.84rem;
      line-height: 1.55;
    }

    @media (max-width: 620px) {
      .statement-grid {
        grid-template-columns: 1fr;
      }
    }
  `

  document.head.appendChild(style)
}
