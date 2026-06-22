import {
  appendInlineFormatting,
  createExcerpt,
  parseArticleContent as parseSectionAwareContent,
  renderArticleUnit as renderBaseArticleUnit,
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
  if (unit.kind === 'statements') {
    return renderStatementGrid(unit, nested)
  }

  return renderBaseArticleUnit(unit, nested)
}
