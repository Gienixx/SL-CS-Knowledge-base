import {
  appendInlineFormatting,
  createExcerpt,
  renderArticleUnit,
  stripInlineFormatting
} from './article-content-renderer.js?v=2'

export {
  appendInlineFormatting,
  createExcerpt,
  renderArticleUnit,
  stripInlineFormatting
}

function parseTextBlocks(rawLines, allowAllHeadings = false) {
  const blocks = []
  let paragraphLines = []
  let currentList = null

  function flushParagraph() {
    const text = paragraphLines
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (text) {
      blocks.push({ type: 'paragraph', text })
    }

    paragraphLines = []
  }

  function closeList() {
    currentList = null
  }

  for (const rawLine of rawLines) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      closeList()
      continue
    }

    const headingPattern = allowAllHeadings
      ? /^#{1,3}\s+(.+)$/
      : /^###\s+(.+)$/
    const subheadingMatch = line.match(headingPattern)

    if (subheadingMatch) {
      flushParagraph()
      closeList()
      blocks.push({
        type: 'subheading',
        text: subheadingMatch[1].trim()
      })
      continue
    }

    const calloutMatch = line.match(/^>\s*(.+)$/)

    if (calloutMatch) {
      flushParagraph()
      closeList()
      blocks.push({
        type: 'callout',
        text: calloutMatch[1].trim()
      })
      continue
    }

    const unorderedItemMatch = line.match(/^[-*]\s+(.+)$/)

    if (unorderedItemMatch) {
      flushParagraph()

      if (!currentList || currentList.type !== 'unordered-list') {
        currentList = {
          type: 'unordered-list',
          items: []
        }
        blocks.push(currentList)
      }

      currentList.items.push(unorderedItemMatch[1].trim())
      continue
    }

    const orderedItemMatch = line.match(/^\d+[.)]\s+(.+)$/)

    if (orderedItemMatch) {
      flushParagraph()

      if (!currentList || currentList.type !== 'ordered-list') {
        currentList = {
          type: 'ordered-list',
          items: []
        }
        blocks.push(currentList)
      }

      currentList.items.push(orderedItemMatch[1].trim())
      continue
    }

    closeList()
    paragraphLines.push(line)
  }

  flushParagraph()
  return blocks
}

function appendTextLine(container, line) {
  const lastSegment = container.segments.at(-1)

  if (lastSegment?.type === 'text') {
    lastSegment.lines.push(line)
    return
  }

  container.segments.push({
    type: 'text',
    lines: [line]
  })
}

function splitTableRow(line) {
  return line
    .split('|')
    .map(cell => cell.trim())
    .filter((cell, index, cells) => {
      if (cell) {
        return true
      }

      return index > 0 && index < cells.length - 1
    })
}

function getTextLines(segments) {
  return segments
    .filter(segment => segment.type === 'text')
    .flatMap(segment => segment.lines)
}

function parseTableUnit(unit) {
  const rows = getTextLines(unit.segments)
    .map(line => line.trim())
    .filter(Boolean)
    .map(splitTableRow)
    .filter(row => row.length >= 2)

  return {
    kind: 'table',
    title: unit.title,
    headers: rows[0] || ['Column 1', 'Column 2'],
    rows: rows.slice(1)
  }
}

function parseRuleUnit(unit) {
  const introLines = []
  const items = []

  for (const rawLine of getTextLines(unit.segments)) {
    const line = rawLine.trim()

    if (!line) {
      continue
    }

    const itemMatch = line.match(/^(\d+)\s*\|\s*(.+)$/)

    if (itemMatch) {
      items.push({
        number: itemMatch[1],
        text: itemMatch[2].trim()
      })
    } else if (!items.length) {
      introLines.push(line)
    }
  }

  return {
    kind: 'rules',
    title: unit.title || 'Rules',
    intro: introLines.join(' ').replace(/\s+/g, ' ').trim(),
    items
  }
}

function parseChecklistUnit(unit) {
  const introLines = []
  const items = []

  for (const rawLine of getTextLines(unit.segments)) {
    const line = rawLine.trim()

    if (!line) {
      continue
    }

    const itemMatch = line.match(/^[-*]\s+(.+)$/)

    if (itemMatch) {
      items.push(itemMatch[1].trim())
    } else if (!items.length) {
      introLines.push(line)
    }
  }

  return {
    kind: 'checklist',
    title: unit.title || 'Checklist',
    intro: introLines.join(' ').replace(/\s+/g, ' ').trim(),
    items
  }
}

function finalizeItems(segments) {
  const items = []

  for (const segment of segments) {
    if (segment.type === 'text') {
      items.push(...parseTextBlocks(segment.lines, true))
      continue
    }

    const nestedUnit = finalizeUnit(segment)

    if (nestedUnit) {
      items.push(nestedUnit)
    }
  }

  return items
}

function finalizeUnit(unit) {
  if (unit.kind === 'table') {
    return parseTableUnit(unit)
  }

  if (unit.kind === 'rules') {
    return parseRuleUnit(unit)
  }

  if (unit.kind === 'checklist') {
    return parseChecklistUnit(unit)
  }

  return {
    kind: unit.kind,
    title: unit.title,
    stepNumber: unit.stepNumber,
    items: finalizeItems(unit.segments)
  }
}

function createStructuredUnit(kind, title, stepNumber) {
  return {
    type: 'unit',
    kind,
    title:
      title ||
      (kind === 'step'
        ? `Step ${stepNumber}`
        : kind === 'rules'
          ? 'Rules'
          : kind === 'response-template'
            ? 'Response Template'
            : kind === 'checklist'
              ? 'Checklist'
              : kind === 'callout'
                ? 'Important Note'
                : ''),
    stepNumber: kind === 'step' ? stepNumber : undefined,
    segments: []
  }
}

function buildSyntaxTree(content) {
  const root = {
    kind: 'root',
    segments: []
  }
  const structuredStack = []
  let activeSection = null
  let stepNumber = 0

  function currentContainer() {
    return structuredStack.at(-1) || activeSection || root
  }

  function ensureImplicitSection() {
    if (activeSection) {
      return activeSection
    }

    activeSection = {
      type: 'unit',
      kind: 'section',
      title: 'Overview',
      explicit: false,
      segments: []
    }
    root.segments.push(activeSection)
    return activeSection
  }

  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === ':::') {
      if (structuredStack.length) {
        structuredStack.pop()
      }
      continue
    }

    if (!structuredStack.length) {
      const sectionMatch = line.match(/^#{1,2}\s+(.+)$/)

      if (sectionMatch) {
        activeSection = {
          type: 'unit',
          kind: 'section',
          title: sectionMatch[1].trim(),
          explicit: true,
          segments: []
        }
        root.segments.push(activeSection)
        continue
      }
    }

    const directiveMatch = line.match(
      /^:::(step|table|rules|response-template|checklist|callout)(?:\s+(.+))?$/i
    )

    if (directiveMatch) {
      const kind = directiveMatch[1].toLowerCase()
      const title = directiveMatch[2]?.trim() || ''

      if (kind === 'step') {
        stepNumber += 1
      }

      const unit = createStructuredUnit(
        kind,
        title,
        stepNumber
      )

      currentContainer().segments.push(unit)
      structuredStack.push(unit)
      continue
    }

    if (!line && !activeSection && !structuredStack.length) {
      continue
    }

    const target = structuredStack.length
      ? structuredStack.at(-1)
      : ensureImplicitSection()

    appendTextLine(target, rawLine)
  }

  return root
}

export function parseArticleContent(content) {
  if (!String(content ?? '').trim()) {
    return []
  }

  const tree = buildSyntaxTree(content)
  const units = []

  for (const segment of tree.segments) {
    if (segment.type === 'text') {
      continue
    }

    const unit = finalizeUnit(segment)

    if (
      unit.kind !== 'section' ||
      segment.explicit ||
      unit.items.length
    ) {
      units.push(unit)
    }
  }

  return units
}
