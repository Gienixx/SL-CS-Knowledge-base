import {
  createExcerpt,
  parseArticleContent as parseBaseContent,
  renderArticleUnit as renderBaseArticleUnit,
  stripInlineFormatting
} from './article-content-renderer-v5.js?v=1'

const LIST_LAYOUT_MARKER = '__LAYOUT_LIST__'
const GRID_LAYOUT_MARKER = '__LAYOUT_GRID__'
const NESTED_BULLET_MARKER = '__NESTED_BULLET__'
const NESTED_ROMAN_MARKER = '__NESTED_ROMAN__'

export {
  createExcerpt,
  stripInlineFormatting
}

function installExtendedFormatStyles() {
  if (document.getElementById('extendedArticleFormatStyles')) {
    return
  }

  const style = document.createElement('style')
  style.id = 'extendedArticleFormatStyles'
  style.textContent = `
    .rule-grid.rule-list-layout {
      grid-template-columns: 1fr !important;
      gap: 0 !important;
    }

    .rule-list-layout .rule-card {
      min-height: 0 !important;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      padding: 12px 0 !important;
      border: 0 !important;
      border-bottom: 1px solid rgba(36, 27, 93, 0.1) !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
    }

    .rule-list-layout .rule-card:last-child {
      border-bottom: 0 !important;
    }

    .rule-list-layout .rule-number {
      margin: 1px 0 0 !important;
    }

    .checklist-grid.checklist-list-layout {
      grid-template-columns: 1fr !important;
      gap: 10px !important;
    }

    .checklist-list-layout > li {
      padding-bottom: 9px;
      border-bottom: 1px solid rgba(36, 27, 93, 0.09);
    }

    .checklist-list-layout > li:last-child {
      padding-bottom: 0;
      border-bottom: 0;
    }

    .editor-nested-list {
      margin: 8px 0 2px 0 !important;
      padding-left: 1.25rem !important;
    }

    .editor-nested-bullet-list,
    .orphan-indented-bullet-list {
      list-style-type: circle !important;
    }

    .editor-nested-roman-list,
    .roman-number-list {
      list-style-type: lower-roman !important;
    }

    .orphan-indented-bullet-list,
    .roman-number-list {
      margin-left: 1.1rem !important;
    }

    .article-body u,
    .article-preview-panel u {
      text-underline-offset: 3px;
      text-decoration-thickness: 1.5px;
    }
  `

  document.head.appendChild(style)
}

function prepareExtendedSyntax(content) {
  const directivePrepared = String(content ?? '')
    .replace(
      /^:::rules-list(?:\s+(.+))?$/gim,
      (_, title = '') =>
        `:::rules ${LIST_LAYOUT_MARKER}${title.trim() || 'Rules'}`
    )
    .replace(
      /^:::rules-grid(?:\s+(.+))?$/gim,
      (_, title = '') =>
        `:::rules ${GRID_LAYOUT_MARKER}${title.trim() || 'Rules'}`
    )
    .replace(
      /^:::checklist-list(?:\s+(.+))?$/gim,
      (_, title = '') =>
        `:::checklist ${LIST_LAYOUT_MARKER}${title.trim() || 'Checklist'}`
    )
    .replace(
      /^:::checklist-grid(?:\s+(.+))?$/gim,
      (_, title = '') =>
        `:::checklist ${GRID_LAYOUT_MARKER}${title.trim() || 'Checklist'}`
    )

  return directivePrepared
    .split('\n')
    .map(rawLine => {
      const nestedBulletMatch = rawLine.match(/^\s{2,}[-*]\s+(.+)$/)

      if (nestedBulletMatch) {
        return `- ${NESTED_BULLET_MARKER}${nestedBulletMatch[1]}`
      }

      const nestedRomanMatch = rawLine.match(
        /^\s+([ivxlcdm]+)[.)]\s+(.+)$/i
      )

      if (nestedRomanMatch) {
        return `1. ${NESTED_ROMAN_MARKER}${nestedRomanMatch[1].toLowerCase()}|${nestedRomanMatch[2]}`
      }

      return rawLine
    })
    .join('\n')
}

function applyLayoutMetadata(unit) {
  if (!unit || typeof unit !== 'object') {
    return unit
  }

  let nextUnit = unit

  if (
    (unit.kind === 'rules' || unit.kind === 'checklist') &&
    typeof unit.title === 'string'
  ) {
    if (unit.title.startsWith(LIST_LAYOUT_MARKER)) {
      nextUnit = {
        ...unit,
        layout: 'list',
        title: unit.title.slice(LIST_LAYOUT_MARKER.length).trim()
      }
    } else if (unit.title.startsWith(GRID_LAYOUT_MARKER)) {
      nextUnit = {
        ...unit,
        layout: 'grid',
        title: unit.title.slice(GRID_LAYOUT_MARKER.length).trim()
      }
    } else {
      nextUnit = {
        ...unit,
        layout: 'grid'
      }
    }
  }

  if (Array.isArray(nextUnit.items)) {
    nextUnit = {
      ...nextUnit,
      items: nextUnit.items.map(item =>
        item && typeof item === 'object' && item.kind
          ? applyLayoutMetadata(item)
          : item
      )
    }
  }

  return nextUnit
}

export function parseArticleContent(content) {
  return parseBaseContent(prepareExtendedSyntax(content)).map(
    applyLayoutMetadata
  )
}

function collectUnits(unit, kind, results = []) {
  if (!unit || typeof unit !== 'object') {
    return results
  }

  if (unit.kind === kind) {
    results.push(unit)
  }

  for (const item of unit.items || []) {
    if (item && typeof item === 'object' && item.kind) {
      collectUnits(item, kind, results)
    }
  }

  return results
}

function includeRoot(element, selector) {
  const matches = []

  if (element.matches(selector)) {
    matches.push(element)
  }

  matches.push(...element.querySelectorAll(selector))
  return matches
}

function applyLayoutClasses(element, unit) {
  const ruleUnits = collectUnits(unit, 'rules')
  const ruleSections = includeRoot(element, '.rich-rules-section')

  ruleSections.forEach((section, index) => {
    const layout = ruleUnits[index]?.layout || 'grid'
    const grid = section.querySelector('.rule-grid')
    grid?.classList.add(
      layout === 'list' ? 'rule-list-layout' : 'rule-grid-layout'
    )
  })

  const checklistUnits = collectUnits(unit, 'checklist')
  const checklistSections = includeRoot(element, '.checklist-section')

  checklistSections.forEach((section, index) => {
    const layout = checklistUnits[index]?.layout || 'grid'
    const grid = section.querySelector('.checklist-grid')
    grid?.classList.add(
      layout === 'list'
        ? 'checklist-list-layout'
        : 'checklist-grid-layout'
    )
  })
}

function replaceUnderlineMarkers(element) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT
  )
  const textNodes = []

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node.nodeValue?.includes('++')) {
      textNodes.push(node)
    }
  }

  for (const textNode of textNodes) {
    const value = textNode.nodeValue || ''
    const pattern = /\+\+([^+\n]+?)\+\+/g
    let previousIndex = 0
    let foundMatch = false
    const fragment = document.createDocumentFragment()

    for (const match of value.matchAll(pattern)) {
      foundMatch = true
      const matchIndex = match.index || 0

      if (matchIndex > previousIndex) {
        fragment.appendChild(
          document.createTextNode(
            value.slice(previousIndex, matchIndex)
          )
        )
      }

      const underline = document.createElement('u')
      underline.textContent = match[1]
      fragment.appendChild(underline)
      previousIndex = matchIndex + match[0].length
    }

    if (!foundMatch) {
      continue
    }

    if (previousIndex < value.length) {
      fragment.appendChild(
        document.createTextNode(value.slice(previousIndex))
      )
    }

    textNode.replaceWith(fragment)
  }
}

function firstMeaningfulTextNode(element) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT
  )

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node.nodeValue?.trim()) {
      return node
    }
  }

  return null
}

function stripLeadingMarker(element, markerPattern) {
  const textNode = firstMeaningfulTextNode(element)

  if (!textNode) {
    return
  }

  textNode.nodeValue = textNode.nodeValue.replace(markerPattern, '')
}

function getDirectListItems(list) {
  return Array.from(list.children).filter(
    child => child.tagName === 'LI'
  )
}

function createNestedList(parentItem, type) {
  const list = document.createElement(type === 'roman' ? 'ol' : 'ul')
  list.className =
    type === 'roman'
      ? 'editor-nested-list editor-nested-roman-list'
      : 'editor-nested-list editor-nested-bullet-list'

  if (type === 'roman') {
    list.type = 'i'
  }

  parentItem.appendChild(list)
  return list
}

function restructureIndentedLists(element) {
  const lists = Array.from(element.querySelectorAll('ul, ol')).filter(
    list => !list.classList.contains('checklist-grid')
  )

  for (const list of lists) {
    const items = getDirectListItems(list)

    if (!items.length) {
      continue
    }

    const itemTypes = items.map(item => {
      const text = item.textContent.trim()

      if (text.startsWith(NESTED_BULLET_MARKER)) {
        return 'bullet'
      }

      if (text.startsWith(NESTED_ROMAN_MARKER)) {
        return 'roman'
      }

      return 'regular'
    })

    if (itemTypes.every(type => type === 'bullet')) {
      list.classList.add('orphan-indented-bullet-list')
      items.forEach(item =>
        stripLeadingMarker(
          item,
          new RegExp(`^\\s*${NESTED_BULLET_MARKER}`)
        )
      )
      continue
    }

    if (itemTypes.every(type => type === 'roman')) {
      list.classList.add('roman-number-list')
      items.forEach(item =>
        stripLeadingMarker(
          item,
          new RegExp(`^\\s*${NESTED_ROMAN_MARKER}[ivxlcdm]+\\|`, 'i')
        )
      )
      continue
    }

    let previousRegularItem = null
    let nestedBulletList = null
    let nestedRomanList = null

    items.forEach((item, index) => {
      const type = itemTypes[index]

      if (type === 'regular') {
        previousRegularItem = item
        nestedBulletList = null
        nestedRomanList = null
        return
      }

      if (!previousRegularItem) {
        if (type === 'bullet') {
          stripLeadingMarker(
            item,
            new RegExp(`^\\s*${NESTED_BULLET_MARKER}`)
          )
        } else {
          stripLeadingMarker(
            item,
            new RegExp(`^\\s*${NESTED_ROMAN_MARKER}[ivxlcdm]+\\|`, 'i')
          )
        }
        return
      }

      if (type === 'bullet') {
        stripLeadingMarker(
          item,
          new RegExp(`^\\s*${NESTED_BULLET_MARKER}`)
        )
        nestedBulletList ||= createNestedList(
          previousRegularItem,
          'bullet'
        )
        nestedBulletList.appendChild(item)
      } else {
        stripLeadingMarker(
          item,
          new RegExp(`^\\s*${NESTED_ROMAN_MARKER}[ivxlcdm]+\\|`, 'i')
        )
        nestedRomanList ||= createNestedList(
          previousRegularItem,
          'roman'
        )
        nestedRomanList.appendChild(item)
      }
    })
  }
}

export function renderArticleUnit(unit, nested = false) {
  installExtendedFormatStyles()
  const element = renderBaseArticleUnit(unit, nested)
  applyLayoutClasses(element, unit)
  restructureIndentedLists(element)
  replaceUnderlineMarkers(element)
  return element
}
