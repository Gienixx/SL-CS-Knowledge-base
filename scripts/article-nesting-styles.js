if (!document.getElementById('articleNestingStyles')) {
  const style = document.createElement('style')
  style.id = 'articleNestingStyles'
  style.textContent = `
    .article-body .step-card,
    .article-body .response-template-card,
    .article-body .callout-card {
      position: relative;
      margin-bottom: 18px;
      padding: 24px 26px;
      border: 1px solid var(--line, rgba(36, 27, 93, 0.12));
      border-radius: var(--radius, 16px);
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.98),
        rgba(250, 246, 238, 0.96)
      );
      box-shadow: 0 14px 36px rgba(36, 27, 93, 0.07);
      scroll-margin-top: 90px;
    }

    .article-body .step-card {
      margin-top: 20px;
    }

    .article-body .callout-card {
      border-left: 3px solid var(--gold, #ffc21a);
      background: linear-gradient(
        135deg,
        rgba(255, 194, 26, 0.08),
        rgba(255, 255, 255, 0.98)
      );
    }

    .article-body .step-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 26px;
      padding: 4px 10px;
      border: 1px solid rgba(255, 194, 26, 0.48);
      border-radius: 999px;
      color: var(--text, #241b5d);
      background: rgba(255, 194, 26, 0.09);
      font-size: 0.68rem;
      font-weight: 850;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .article-body .step-card-title,
    .article-body .callout-card-title,
    .article-body .response-template-title {
      color: var(--text, #241b5d);
      line-height: 1.4;
    }

    .article-body .step-card-title {
      margin: 14px 0 10px;
      font-size: 1.06rem;
    }

    .article-body .callout-card-title,
    .article-body .response-template-title {
      margin: 0 0 14px;
      font-size: 0.98rem;
    }

    .article-body .step-card p,
    .article-body .step-card li,
    .article-body .callout-card p,
    .article-body .callout-card li,
    .article-body .response-template-card p,
    .article-body .response-template-card li {
      color: var(--muted, #6f678f);
      font-size: 1rem;
      line-height: 1.74;
    }

    .article-body .rich-table-wrapper {
      overflow-x: auto;
      border: 1px solid rgba(36, 27, 93, 0.12);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.92);
    }

    .article-body .rich-table {
      width: 100%;
      min-width: 560px;
      border-collapse: collapse;
    }

    .article-body .rich-table th,
    .article-body .rich-table td {
      padding: 18px 20px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid rgba(36, 27, 93, 0.09);
    }

    .article-body .rich-table th {
      color: var(--text, #241b5d);
      background: rgba(255, 194, 26, 0.1);
      font-size: 0.74rem;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .article-body .rich-table td {
      color: var(--muted, #6f678f);
      font-size: 0.96rem;
      line-height: 1.6;
    }

    .article-body .rich-table tbody tr:last-child td {
      border-bottom: none;
    }

    .article-body .rich-intro {
      margin-bottom: 18px !important;
    }

    .article-body .rule-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .article-body .rule-card {
      min-height: 126px;
      padding: 16px;
      border: 1px solid rgba(36, 27, 93, 0.11);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.82);
    }

    .article-body .rule-number {
      display: inline-flex;
      min-width: 21px;
      min-height: 21px;
      align-items: center;
      justify-content: center;
      margin-bottom: 10px;
      border-radius: 6px;
      color: var(--text, #241b5d);
      background: rgba(255, 194, 26, 0.14);
      font-size: 0.72rem;
      font-weight: 850;
    }

    .article-body .rule-card p {
      margin: 0;
      color: var(--muted, #6f678f);
      font-size: 0.94rem;
      line-height: 1.65;
    }

    .article-body .response-template-card {
      border-left: 2px solid var(--text, #241b5d);
    }

    .article-body .checklist-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 26px;
      padding: 0 !important;
      margin: 14px 0 0 !important;
      list-style: none;
    }

    .article-body .checklist-grid li {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 9px;
      margin: 0 !important;
    }

    .article-body .checklist-mark {
      color: var(--text, #241b5d);
      font-weight: 900;
    }

    .article-body .nested-rich-unit {
      margin: 18px 0 4px;
      padding: 18px;
      border: 1px solid rgba(36, 27, 93, 0.11);
      border-radius: 13px;
      background: rgba(255, 255, 255, 0.72);
      box-shadow: none;
    }

    .article-body .nested-rich-unit .rich-section-title {
      margin-top: 0;
      font-size: 1rem;
    }

    .article-body .step-card .rich-table-section.nested-rich-unit {
      margin: 18px 0 4px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }

    .article-preview-panel .step-card {
      margin-top: 16px;
    }

    .article-preview-panel .callout-card {
      margin: 0;
      padding: 18px;
      border: 1px solid rgba(36, 27, 93, 0.1);
      border-left: 3px solid #ffc21a;
      border-radius: 14px;
      background: linear-gradient(
        135deg,
        rgba(255, 194, 26, 0.08),
        rgba(255, 255, 255, 0.98)
      );
      box-shadow: 0 10px 24px rgba(36, 27, 93, 0.05);
    }

    .article-preview-panel .callout-card-title {
      margin: 0 0 10px;
      color: var(--sl-navy, #241b5d);
      font-size: 0.92rem;
      line-height: 1.4;
    }

    .article-preview-panel .nested-rich-unit {
      margin: 14px 0 2px;
      padding: 14px;
      border: 1px solid rgba(36, 27, 93, 0.1);
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.7);
      box-shadow: none;
    }

    .article-preview-panel .nested-rich-unit .rich-section-title {
      margin-top: 0;
      font-size: 0.92rem;
    }

    .article-preview-panel .step-card .rich-table-section.nested-rich-unit {
      margin: 14px 0 2px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }

    @media (max-width: 620px) {
      .article-body .rule-grid,
      .article-body .checklist-grid {
        grid-template-columns: 1fr;
      }

      .article-body .step-card,
      .article-body .callout-card,
      .article-body .response-template-card {
        padding: 20px 18px;
      }
    }
  `

  document.head.appendChild(style)
}
