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
  `

  document.head.appendChild(style)
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
  return stripBaseInlineFormatting(text).replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    '$1'
  )
}

export function createExcerpt(units, rawContent) {
  return stripInlineFormatting(
    createBaseExcerpt(units, rawContent)
  )
}

export function renderArticleUnit(unit, nested = false) {
  installArticleLinkStyles()
  const element = renderBaseArticleUnit(unit, nested)
  replaceInlineLinks(element)
  return element
}
