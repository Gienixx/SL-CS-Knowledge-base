import {
  createExcerpt,
  parseArticleContent as parseBaseContent,
  renderArticleUnit as renderBaseArticleUnit,
  stripInlineFormatting
} from './article-content-renderer-v6.js?v=1'

const ALIGN_MARKER = '__ARTICLE_ALIGN__'
const INDENT_MARKER = '__ARTICLE_INDENT__'

export {
  createExcerpt,
  stripInlineFormatting
}

function installLayoutStyles() {
  if (document.getElementById('articleLayoutBlockStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleLayoutBlockStyles'
  style.textContent = `
    .article-alignment-block,
    .article-indent-block {
      margin: 12px 0;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible !important;
    }

    .article-align-left {
      text-align: left;
    }

    .article-align-center {
      text-align: center;
    }

    .article-align-right {
      text-align: right;
    }

    .article-align-justify {
      text-align: justify;
      text-justify: inter-word;
    }

    .article-align-center > ul,
    .article-align-center > ol,
    .article-align-right > ul,
    .article-align-right > ol {
      display: inline-block;
      text-align: left;
    }

    .article-indent-level-1 {
      margin-left: 2rem !important;
    }

    .article-indent-level-2 {
      margin-left: 4rem !important;
    }

    .article-indent-level-3 {
      margin-left: 6rem !important;
    }

    .article-indent-level-4 {
      margin-left: 8rem !important;
    }

    .article-indent-level-5 {
      margin-left: 10rem !important;
    }

    .article-indent-level-6 {
      margin-left: 12rem !important;
    }

    @media (max-width: 700px) {
      .article-indent-level-1,
      .article-indent-level-2 {
        margin-left: 1.25rem !important;
      }

      .article-indent-level-3,
      .article-indent-level-4,
      .article-indent-level-5,
      .article-indent-level-6 {
        margin-left: 2.25rem !important;
      }
    }
  `

  document.head.appendChild(style)
}

function prepareLayoutSyntax(content) {
  return String(content ?? '')
    .replace(
      /^:::align-(left|center|right|justify)\s*$/gim,
      (_, mode) => `:::callout ${ALIGN_MARKER}${mode.toLowerCase()}`
    )
    .replace(
      /^:::indent\s+([1-6])\s*$/gim,
      (_, level) => `:::callout ${INDENT_MARKER}${level}`
    )
}

export function parseArticleContent(content) {
  return parseBaseContent(prepareLayoutSyntax(content))
}

function transformLayoutWrappers(element) {
  const titles = Array.from(
    element.querySelectorAll('.callout-card-title')
  )

  for (const title of titles) {
    const titleText = title.textContent.trim()
    const container = title.closest('.callout-card')

    if (!container) {
      continue
    }

    if (titleText.startsWith(ALIGN_MARKER)) {
      const mode = titleText.slice(ALIGN_MARKER.length)

      container.classList.remove('callout-card', 'nested-rich-unit')
      container.classList.add(
        'article-alignment-block',
        `article-align-${mode}`
      )
      title.remove()
      continue
    }

    if (titleText.startsWith(INDENT_MARKER)) {
      const level = Number.parseInt(
        titleText.slice(INDENT_MARKER.length),
        10
      )
      const safeLevel = Number.isFinite(level)
        ? Math.min(Math.max(level, 1), 6)
        : 1

      container.classList.remove('callout-card', 'nested-rich-unit')
      container.classList.add(
        'article-indent-block',
        `article-indent-level-${safeLevel}`
      )
      title.remove()
    }
  }
}

export function renderArticleUnit(unit, nested = false) {
  installLayoutStyles()
  const element = renderBaseArticleUnit(unit, nested)
  transformLayoutWrappers(element)
  return element
}
