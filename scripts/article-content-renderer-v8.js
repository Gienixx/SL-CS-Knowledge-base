import {
  createExcerpt as createBaseExcerpt,
  parseArticleContent,
  renderArticleUnit as renderBaseArticleUnit,
  stripInlineFormatting as stripBaseInlineFormatting
} from './article-content-renderer-v7.js?v=1'
import {
  findArticleLinks,
  isExternalArticleLink,
} from './article-link-utils.js?v=2'

export { parseArticleContent }

const TEXT_BLOCK_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'p',
  'li',
  'th',
  'td',
  '.rich-callout',
  '.step-badge'
].join(', ')

function installArticleLinkStyles() {
  if (document.getElementById('articleInlineLinkStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'articleInlineLinkStyles'
  style.textContent = `
    .article-body .article-inline-link,
    .article-preview-panel .article-inline-link {
      color: #4c3a9d;
      font-weight: 650;
      text-decoration: underline;
      text-decoration-color: rgba(76, 58, 157, 0.42);
      text-decoration-thickness: 1.5px;
      text-underline-offset: 3px;
      overflow-wrap: anywhere;
    }

    .article-body .article-inline-link:hover,
    .article-preview-panel .article-inline-link:hover {
      color: var(--sl-navy, #241b5d);
      text-decoration-color: currentColor;
    }

    .article-body .article-inline-link:focus-visible,
    .article-preview-panel .article-inline-link:focus-visible {
      outline: 3px solid rgba(255, 194, 26, 0.32);
      outline-offset: 3px;
      border-radius: 3px;
    }

    .article-inline-image {
      display: grid;
      gap: 8px;
      max-width: 100%;
      margin-top: 18px;
      margin-bottom: 18px;
    }

    .article-inline-image img {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid var(--site-border, rgba(36, 27, 93, 0.14));
      border-radius: 14px;
      background: var(--site-surface-soft, rgba(255, 255, 255, 0.7));
    }

    .article-inline-image figcaption {
      color: var(--site-muted, var(--sl-muted));
      font-size: 0.82rem;
      line-height: 1.45;
    }

    .article-image-align-left {
      margin-right: auto;
      text-align: left;
    }

    .article-image-align-center {
      margin-right: auto;
      margin-left: auto;
      text-align: center;
    }

    .article-image-align-right {
      margin-left: auto;
      text-align: right;
    }

    .article-image-width-small { width: min(320px, 100%); }
    .article-image-width-medium { width: min(520px, 100%); }
    .article-image-width-large { width: min(760px, 100%); }
    .article-image-width-full { width: 100%; }
  `

  document.head.appendChild(style)
}

function parseInlineImageSyntax(text) {
  const match = String(text || '').trim().match(
    /^!\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)(?:\s+"([^"\n]{1,240})")?\)\{align=(left|center|right)\s+width=(small|medium|large|full)\}$/i
  )

  if (!match) return null

  try {
    const url = new URL(match[2])
    if (!['http:', 'https:'].includes(url.protocol)) return null

    return {
      alt: match[1].trim(),
      url: url.href,
      caption: match[3]?.trim() || '',
      alignment: match[4].toLowerCase(),
      width: match[5].toLowerCase()
    }
  } catch {
    return null
  }
}

function replaceInlineImages(element) {
  for (const paragraph of includeRoot(element, 'p')) {
    const imageData = parseInlineImageSyntax(paragraph.textContent)
    if (!imageData) continue

    const figure = document.createElement('figure')
    figure.className =
      `article-inline-image article-image-align-${imageData.alignment} ` +
      `article-image-width-${imageData.width}`

    const image = document.createElement('img')
    image.src = imageData.url
    image.alt = imageData.alt
    image.loading = 'lazy'
    image.decoding = 'async'
    figure.appendChild(image)

    if (imageData.caption) {
      const caption = document.createElement('figcaption')
      caption.textContent = imageData.caption
      figure.appendChild(caption)
    }

    paragraph.replaceWith(figure)
  }
}

function createArticleLink(label, href) {
  const link = document.createElement('a')
  link.className = 'article-inline-link'
  link.href = href
  link.textContent = label

  if (isExternalArticleLink(href)) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }

  return link
}

function includeRoot(element, selector) {
  const matches = []

  if (element.matches(selector)) {
    matches.push(element)
  }

  matches.push(...element.querySelectorAll(selector))
  return matches
}

function getLinkableTextNodes(container) {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT
  )
  const textNodes = []

  while (walker.nextNode()) {
    const node = walker.currentNode
    const parent = node.parentElement

    if (
      !node.nodeValue ||
      parent?.closest('a, script, style, code') ||
      parent?.closest(TEXT_BLOCK_SELECTOR) !== container
    ) {
      continue
    }

    textNodes.push(node)
  }

  return textNodes
}

function locateTextOffset(textNodes, requestedOffset) {
  let traversedLength = 0

  for (const node of textNodes) {
    const nodeLength = node.nodeValue?.length || 0

    if (requestedOffset <= traversedLength + nodeLength) {
      return {
        node,
        offset: requestedOffset - traversedLength
      }
    }

    traversedLength += nodeLength
  }

  return null
}

function replaceLinksInTextBlock(container) {
  const textNodes = getLinkableTextNodes(container)

  if (!textNodes.length) {
    return
  }

  const text = textNodes
    .map(node => node.nodeValue || '')
    .join('')
  const links = findArticleLinks(text)

  for (const linkData of links.reverse()) {
    const start = locateTextOffset(textNodes, linkData.start)
    const end = locateTextOffset(textNodes, linkData.end)

    if (!start || !end) {
      continue
    }

    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)

    const link = createArticleLink(
      linkData.label,
      linkData.href
    )

    if (linkData.customLabel) {
      range.deleteContents()
    } else {
      link.replaceChildren(range.extractContents())
    }

    range.insertNode(link)
    range.detach()
  }
}

function replaceInlineLinks(element) {
  const textBlocks = includeRoot(element, TEXT_BLOCK_SELECTOR)

  for (const textBlock of textBlocks) {
    replaceLinksInTextBlock(textBlock)
  }
}

export function stripInlineFormatting(text) {
  return stripBaseInlineFormatting(text)
    .replace(
      /!\[([^\]\n]+)\]\(([^)\n]+)\)\{align=(?:left|center|right)\s+width=(?:small|medium|large|full)\}/gi,
      '$1'
    )
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1')
}

export function createExcerpt(units, rawContent) {
  return stripInlineFormatting(
    createBaseExcerpt(units, rawContent)
  )
}

export function renderArticleUnit(unit, nested = false) {
  installArticleLinkStyles()
  const element = renderBaseArticleUnit(unit, nested)
  replaceInlineImages(element)
  replaceInlineLinks(element)
  return element
}
