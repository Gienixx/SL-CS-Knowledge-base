export function stripInlineFormatting(text) {
  return String(text ?? '')
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
}

export function appendInlineFormatting(container, text) {
  const value = String(text ?? '')
  const pattern =
    /(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g

  let previousIndex = 0

  for (const match of value.matchAll(pattern)) {
    const matchIndex = match.index ?? 0

    if (matchIndex > previousIndex) {
      container.appendChild(
        document.createTextNode(value.slice(previousIndex, matchIndex))
      )
    }

    const formattedText = match[0]

    if (
      formattedText.startsWith('***') &&
      formattedText.endsWith('***')
    ) {
      const strong = document.createElement('strong')
      const emphasis = document.createElement('em')
      emphasis.textContent = formattedText.slice(3, -3)
      strong.appendChild(emphasis)
      container.appendChild(strong)
    } else if (
      formattedText.startsWith('**') &&
      formattedText.endsWith('**')
    ) {
      const strong = document.createElement('strong')
      strong.textContent = formattedText.slice(2, -2)
      container.appendChild(strong)
    } else {
      const emphasis = document.createElement('em')
      emphasis.textContent = formattedText.slice(1, -1)
      container.appendChild(emphasis)
    }

    previousIndex = matchIndex + formattedText.length
  }

  if (previousIndex < value.length) {
    container.appendChild(
      document.createTextNode(value.slice(previousIndex))
    )
  }
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

function buildSyntaxTree(content) {
  const root = {
    kind: 'root',
    segments: []
  }
  const stack = [root]
  let stepNumber = 0

  function appendTextLine(node, line) {
    const lastSegment = node.segments.at(-1)

    if (lastSegment?.type === 'text') {
      lastSegment.lines.push(line)
      return
    }

    node.segments.push({
      type: 'text',
      lines: [line]
    })
  }

  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const currentNode = stack.at(-1)

    if (line === ':::') {
      if (stack.length > 1) {
        stack.pop()
      }
      continue
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

      const unit = {
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

      currentNode.segments.push(unit)
      stack.push(unit)
      continue
    }

    appendTextLine(currentNode, rawLine)
  }

  return root
}

function finalizeContainerItems(segments) {
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
    items: finalizeContainerItems(unit.segments)
  }
}

function parseRootText(lines) {
  const sections = []
  let currentSection = null
  let currentLines = []

  function flushSection() {
    if (!currentSection) {
      return
    }

    currentSection.items = parseTextBlocks(currentLines)

    if (currentSection.explicit || currentSection.items.length) {
      sections.push(currentSection)
    }

    currentSection = null
    currentLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const sectionMatch = line.match(/^#{1,2}\s+(.+)$/)

    if (sectionMatch) {
      flushSection()
      currentSection = {
        kind: 'section',
        title: sectionMatch[1].trim(),
        explicit: true,
        items: []
      }
      continue
    }

    if (!currentSection && line) {
      currentSection = {
        kind: 'section',
        title: 'Overview',
        explicit: false,
        items: []
      }
    }

    if (currentSection) {
      currentLines.push(rawLine)
    }
  }

  flushSection()
  return sections
}

export function parseArticleContent(content) {
  if (!String(content ?? '').trim()) {
    return []
  }

  const tree = buildSyntaxTree(content)
  const units = []

  for (const segment of tree.segments) {
    if (segment.type === 'text') {
      units.push(...parseRootText(segment.lines))
      continue
    }

    const unit = finalizeUnit(segment)

    if (unit) {
      units.push(unit)
    }
  }

  return units
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

    for (const itemText of block.items) {
      const item = document.createElement('li')
      appendInlineFormatting(item, itemText)
      list.appendChild(item)
    }

    return list
  }

  const paragraph = document.createElement('p')
  appendInlineFormatting(paragraph, block.text)
  return paragraph
}

function appendContentItems(container, items) {
  for (const item of items || []) {
    if (item.kind) {
      container.appendChild(renderArticleUnit(item, true))
    } else {
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
  appendInlineFormatting(heading, unit.title)
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

  for (const headerText of unit.headers) {
    const header = document.createElement('th')
    appendInlineFormatting(header, headerText)
    headerRow.appendChild(header)
  }

  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')

  for (const row of unit.rows) {
    const rowElement = document.createElement('tr')

    for (let index = 0; index < unit.headers.length; index += 1) {
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
  appendInlineFormatting(heading, unit.title)
  section.appendChild(heading)

  if (unit.intro) {
    const intro = document.createElement('p')
    intro.className = 'rich-intro'
    appendInlineFormatting(intro, unit.intro)
    section.appendChild(intro)
  }

  const grid = document.createElement('div')
  grid.className = 'rule-grid'

  for (const itemData of unit.items) {
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
  appendInlineFormatting(heading, unit.title)
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
  appendInlineFormatting(heading, unit.title)
  section.appendChild(heading)

  if (unit.intro) {
    const intro = document.createElement('p')
    intro.className = 'rich-intro'
    appendInlineFormatting(intro, unit.intro)
    section.appendChild(intro)
  }

  const list = document.createElement('ul')
  list.className = 'checklist-grid'

  for (const itemText of unit.items) {
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
  appendInlineFormatting(heading, unit.title)
  section.appendChild(heading)
  appendContentItems(section, unit.items)
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

  return renderStandardUnit(unit, nested)
}

function shortenText(text, maximumLength) {
  const normalized = stripInlineFormatting(text)
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return `${normalized.slice(0, maximumLength).trim()}…`
}

function findExcerptInItems(items) {
  for (const item of items || []) {
    if (item.kind) {
      const nestedExcerpt = findExcerptInUnit(item)

      if (nestedExcerpt) {
        return nestedExcerpt
      }
      continue
    }

    if (item.type === 'paragraph' || item.type === 'callout') {
      return item.text
    }

    if (
      item.type === 'unordered-list' ||
      item.type === 'ordered-list'
    ) {
      return item.items[0] || ''
    }
  }

  return ''
}

function findExcerptInUnit(unit) {
  if (unit.intro) {
    return unit.intro
  }

  if (unit.kind === 'table' && unit.rows[0]?.[1]) {
    return unit.rows[0][1]
  }

  if (unit.kind === 'rules' && unit.items[0]?.text) {
    return unit.items[0].text
  }

  if (unit.kind === 'checklist' && unit.items[0]) {
    return unit.items[0]
  }

  return findExcerptInItems(unit.items)
}

export function createExcerpt(units, rawContent) {
  for (const unit of units) {
    const excerpt = findExcerptInUnit(unit)

    if (excerpt) {
      return shortenText(excerpt, 180)
    }
  }

  return shortenText(
    String(rawContent ?? '')
      .replace(/:::[^\n]*/g, ' ')
      .replace(/[#>*|\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    180
  )
}
