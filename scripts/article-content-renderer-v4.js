import {
  appendInlineFormatting,
  createExcerpt,
  parseArticleContent as parseSectionAwareContent,
  stripInlineFormatting
} from './article-content-renderer-v3.js?v=1'
import './article-statement-grid-styles.js?v=1'

const GRID_MARKER = '__QUOTE_CARD_GRID__'

export {
  appendInlineFormatting,
  createExcerpt,
  stripInlineFormatting
}

function prepareContent(content) {
  return String(content ?? '').replace(
    /^:::statements(?:\s+(.+))?$/gim,
    (_, title = '') =>
      `:::checklist ${GRID_MARKER}${title.trim() || 'Common User Statements'}`
  )
}

function convertGridUnits(unit) {
  if (!unit || typeof unit !== 'object') {
    return unit
  }

  if (
    unit.kind === 'checklist' &&
    String(unit.title || '').startsWith(GRID_MARKER)
  ) {
    return {
      ...unit,
      kind: 'statements',
      title:
        String(unit.title).slice(GRID_MARKER.length).trim() ||
        'Common User Statements'
    }
  }

  if (Array.isArray(unit.items)) {
    return {
      ...unit,
      items: unit.items.map(item =>
        item && typeof item === 'object' && item.kind
          ? convertGridUnits(item)
          : item
      )
    }
  }

  return unit
}

export function parseArticleContent(content) {
  return parseSectionAwareContent(prepareContent(content)).map(
    convertGridUnits
  )
}

function renderTextBlock(block) {
  if (block.type === 'subheading') {
    const heading = document.createElement('h3')
    heading.className = 'rich-subheading'
    appendInlineFormatting(heading, block.text)
    return heading
  }

  if (block.type === 'callout') {
    const callout = document.createElement('div')
    callout.className = 'callout rich-callout'
    appendInlineFormatting(callout, block.text)
    return callout
  }

  if (
    block.type === 'unordered-list' ||
    block.type === 'ordered-list'
  ) {
    const list =
      block.type === 'ordered-list'
        ? document.createElement('ol')
        : document.createElement('ul')

    for (const itemText of block.items || []) {
      const item = document.createElement('li')
      appendInlineFormatting(item, itemText)
      list.appendChild(item)
    }

    return list
  }

  const paragraph = document.createElement('p')
  appendInlineFormatting(paragraph, block.text || '')
  return paragraph
}

function appendContentItems(container, items) {
  for (const item of items || []) {
    if (item && typeof item === 'object' && item.kind) {
      container.appendChild(renderArticleUnit(item, true))
    } else if (item && typeof item === 'object') {
      container.appendChild(renderTextBlock(item))
    }
  }
}

function renderStandardUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = unit.kind === 'step' ? 'step-card' : 'section'

  if (nested) {
    section.classList.add('nested-rich-unit')
  }

  if (unit.kind === 'step') {
    const badge = document.createElement('span')
    badge.className = 'step-badge'
    badge.textContent = `Step ${unit.stepNumber}`
    section.appendChild(badge)
  }

  const heading = document.createElement('h2')
  heading.className =
    unit.kind === 'step' ? 'step-card-title' : 'rich-section-title'
  appendInlineFormatting(heading, unit.title || 'Article Section')
  section.appendChild(heading)
  appendContentItems(section, unit.items)
  return section
}

function renderTableUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = nested
    ? 'rich-table-section nested-rich-unit'
    : 'section rich-table-section'

  if (unit.title) {
    const heading = document.createElement('h2')
    heading.className = 'rich-section-title'
    appendInlineFormatting(heading, unit.title)
    section.appendChild(heading)
  }

  const wrapper = document.createElement('div')
  wrapper.className = 'rich-table-wrapper'
  const table = document.createElement('table')
  table.className = 'rich-table'
  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')

  for (const headerText of unit.headers || []) {
    const header = document.createElement('th')
    appendInlineFormatting(header, headerText)
    headerRow.appendChild(header)
  }

  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')

  for (const row of unit.rows || []) {
    const rowElement = document.createElement('tr')

    for (let index = 0; index < (unit.headers || []).length; index += 1) {
      const cell = document.createElement('td')
      appendInlineFormatting(cell, row[index] || '')
      rowElement.appendChild(cell)
    }

    tbody.appendChild(rowElement)
  }

  table.appendChild(tbody)
  wrapper.appendChild(table)
  section.appendChild(wrapper)
  return section
}

function renderRulesUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = nested
    ? 'rich-rules-section nested-rich-unit'
    : 'section rich-rules-section'

  const heading = document.createElement('h2')
  heading.className = 'rich-section-title'
  appendInlineFormatting(heading, unit.title || 'Rules')
  section.appendChild(heading)

  if (unit.intro) {
    const intro = document.createElement('p')
    intro.className = 'rich-intro'
    appendInlineFormatting(intro, unit.intro)
    section.appendChild(intro)
  }

  const grid = document.createElement('div')
  grid.className = 'rule-grid'

  for (const itemData of unit.items || []) {
    const item = document.createElement('div')
    item.className = 'rule-card'

    const number = document.createElement('span')
    number.className = 'rule-number'
    number.textContent = itemData.number

    const text = document.createElement('p')
    appendInlineFormatting(text, itemData.text)

    item.append(number, text)
    grid.appendChild(item)
  }

  section.appendChild(grid)
  return section
}

function renderResponseTemplateUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = 'response-template-card'

  if (nested) {
    section.classList.add('nested-rich-unit')
  }

  const heading = document.createElement('h3')
  heading.className = 'response-template-title'
  appendInlineFormatting(
    heading,
    unit.title || 'Response Template'
  )
  section.appendChild(heading)
  appendContentItems(section, unit.items)
  return section
}

function renderChecklistUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = nested
    ? 'checklist-section nested-rich-unit'
    : 'section checklist-section'

  const heading = document.createElement('h2')
  heading.className = 'rich-section-title'
  appendInlineFormatting(heading, unit.title || 'Checklist')
  section.appendChild(heading)

  if (unit.intro) {
    const intro = document.createElement('p')
    intro.className = 'rich-intro'
    appendInlineFormatting(intro, unit.intro)
    section.appendChild(intro)
  }

  const list = document.createElement('ul')
  list.className = 'checklist-grid'

  for (const itemText of unit.items || []) {
    const item = document.createElement('li')
    const check = document.createElement('span')
    check.className = 'checklist-mark'
    check.textContent = '✓'

    const text = document.createElement('span')
    appendInlineFormatting(text, itemText)

    item.append(check, text)
    list.appendChild(item)
  }

  section.appendChild(list)
  return section
}

function renderCalloutUnit(unit, nested) {
  const section = document.createElement('section')
  section.className = 'callout-card'

  if (nested) {
    section.classList.add('nested-rich-unit')
  }

  const heading = document.createElement('h3')
  heading.className = 'callout-card-title'
  appendInlineFormatting(heading, unit.title || 'Important Note')
  section.appendChild(heading)
  appendContentItems(section, unit.items)
  return section
}

function renderStatementGrid(unit, nested) {
  const section = document.createElement('section')
  section.className = nested
    ? 'statement-grid-section nested-rich-unit'
    : 'section statement-grid-section'

  const heading = document.createElement('h2')
  heading.className = 'rich-section-title statement-grid-title'
  appendInlineFormatting(heading, unit.title)
  section.appendChild(heading)

  if (unit.intro) {
    const intro = document.createElement('p')
    intro.className = 'rich-intro statement-grid-intro'
    appendInlineFormatting(intro, unit.intro)
    section.appendChild(intro)
  }

  const grid = document.createElement('div')
  grid.className = 'statement-grid'

  for (const statementText of unit.items || []) {
    const card = document.createElement('div')
    card.className = 'statement-card'

    const statement = document.createElement('p')
    appendInlineFormatting(statement, statementText)

    card.appendChild(statement)
    grid.appendChild(card)
  }

  section.appendChild(grid)
  return section
}

export function renderArticleUnit(unit, nested = false) {
  if (unit.kind === 'table') {
    return renderTableUnit(unit, nested)
  }

  if (unit.kind === 'rules') {
    return renderRulesUnit(unit, nested)
  }

  if (unit.kind === 'response-template') {
    return renderResponseTemplateUnit(unit, nested)
  }

  if (unit.kind === 'checklist') {
    return renderChecklistUnit(unit, nested)
  }

  if (unit.kind === 'callout') {
    return renderCalloutUnit(unit, nested)
  }

  if (unit.kind === 'statements') {
    return renderStatementGrid(unit, nested)
  }

  return renderStandardUnit(unit, nested)
}
