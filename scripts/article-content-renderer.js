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

function parseTextBlocks(rawLines) {
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

    const subheadingMatch = line.match(/^###\s+(.+)$/)

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
  closeList()
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

function parseTableUnit(unit) {
  const rows = unit.rawLines
    .map(line => line.trim())
    .filter(Boolean)
    .map(splitTableRow)
    .filter(row => row.length >= 2)

  return {
    ...unit,
    headers: rows[0] || ['Column 1', 'Column 2'],
    rows: rows.slice(1)
  }
}

function parseRuleUnit(unit) {
  const introLines = []
  const items = []

  for (const rawLine of unit.rawLines) {
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
    ...unit,
    intro: introLines.join(' ').replace(/\s+/g, ' ').trim(),
    items
  }
}

function parseChecklistUnit(unit) {
  const introLines = []
  const items = []

  for (const rawLine of unit.rawLines) {
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
    ...unit,
    intro: introLines.join(' ').replace(/\s+/g, ' ').trim(),
    items
  }
}

function finalizeRichUnit(unit) {
  if (!unit) {
    return null
  }

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
    ...unit,
    blocks: parseTextBlocks(unit.rawLines)
  }
}

export function parseArticleContent(content) {
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const units = []
  let currentSection = null
  let sectionLines = []
  let richUnit = null
  let stepNumber = 0

  function flushSection() {
    if (!currentSection) {
      return
    }

    currentSection.blocks = parseTextBlocks(sectionLines)
    units.push(currentSection)
    currentSection = null
    sectionLines = []
  }

  function ensureSection() {
    if (!currentSection) {
      currentSection = {
        kind: 'section',
        title: 'Overview',
        blocks: []
      }
    }

    return currentSection
  }

  function closeRichUnit() {
    if (!richUnit) {
      return
    }

    units.push(finalizeRichUnit(richUnit))
    richUnit = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (richUnit) {
      if (line === ':::') {
        closeRichUnit()
      } else {
        richUnit.rawLines.push(rawLine)
      }
      continue
    }

    const directiveMatch = line.match(
      /^:::(step|table|rules|response-template|checklist)(?:\s+(.+))?$/i
    )

    if (directiveMatch) {
      flushSection()
      const kind = directiveMatch[1].toLowerCase()
      const title = directiveMatch[2]?.trim() || ''

      if (kind === 'step') {
        stepNumber += 1
      }

      richUnit = {
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
                  : ''),
        stepNumber: kind === 'step' ? stepNumber : undefined,
        rawLines: []
      }
      continue
    }

    const sectionHeadingMatch = line.match(/^#{1,2}\s+(.+)$/)

    if (sectionHeadingMatch) {
      flushSection()
      currentSection = {
        kind: 'section',
        title: sectionHeadingMatch[1].trim(),
        blocks: []
      }
      continue
    }

    ensureSection()
    sectionLines.push(rawLine)
  }

  closeRichUnit()
  flushSection()

  return units.filter(Boolean)
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

function appendBlocks(container, blocks) {
  for (const block of blocks || []) {
    container.appendChild(renderTextBlock(block))
  }
}

function renderStandardUnit(unit) {
  const section = document.createElement('section')
  section.className = unit.kind === 'step' ? 'step-card' : 'section'

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
  appendBlocks(section, unit.blocks)
  return section
}

function renderTableUnit(unit) {
  const section = document.createElement('section')
  section.className = 'section rich-table-section'

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

function renderRulesUnit(unit) {
  const section = document.createElement('section')
  section.className = 'section rich-rules-section'

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

function renderResponseTemplateUnit(unit) {
  const section = document.createElement('section')
  section.className = 'response-template-card'

  const heading = document.createElement('h3')
  heading.className = 'response-template-title'
  appendInlineFormatting(heading, unit.title)
  section.appendChild(heading)
  appendBlocks(section, unit.blocks)
  return section
}

function renderChecklistUnit(unit) {
  const section = document.createElement('section')
  section.className = 'section checklist-section'

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

export function renderArticleUnit(unit) {
  if (unit.kind === 'table') {
    return renderTableUnit(unit)
  }

  if (unit.kind === 'rules') {
    return renderRulesUnit(unit)
  }

  if (unit.kind === 'response-template') {
    return renderResponseTemplateUnit(unit)
  }

  if (unit.kind === 'checklist') {
    return renderChecklistUnit(unit)
  }

  return renderStandardUnit(unit)
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

export function createExcerpt(units, rawContent) {
  for (const unit of units) {
    if (unit.intro) {
      return shortenText(unit.intro, 180)
    }

    if (unit.kind === 'table' && unit.rows[0]?.[1]) {
      return shortenText(unit.rows[0][1], 180)
    }

    if (unit.kind === 'rules' && unit.items[0]?.text) {
      return shortenText(unit.items[0].text, 180)
    }

    if (unit.kind === 'checklist' && unit.items[0]) {
      return shortenText(unit.items[0], 180)
    }

    for (const block of unit.blocks || []) {
      if (block.type === 'paragraph' || block.type === 'callout') {
        return shortenText(block.text, 180)
      }

      if (
        block.type === 'unordered-list' ||
        block.type === 'ordered-list'
      ) {
        const firstItem = block.items[0]

        if (firstItem) {
          return shortenText(firstItem, 180)
        }
      }
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
