import {
  WORKBOOK_SOURCE_INVENTORY
} from './workbook-source-inventory.js'

const PRODUCTIVITY_METRICS = Object.freeze([
  Object.freeze({
    sourceHeader: 'Solved Ticket',
    targetColumn: 'solved_tickets',
    valueType: 'integer',
    nullable: false
  }),
  Object.freeze({
    sourceHeader: 'Open Tickets',
    targetColumn: 'open_tickets',
    valueType: 'integer',
    nullable: true
  }),
  Object.freeze({
    sourceHeader: 'AHT',
    targetColumn: 'aht_value',
    valueType: 'number',
    nullable: true
  })
])

export const PRODUCTIVITY_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName:
      WORKBOOK_SOURCE_INVENTORY.ticketProductivity.sheetName,
    range: "'Ticket Productivity'!A:AB",
    headerRows: Object.freeze([1, 2]),
    dataStartRow:
      WORKBOOK_SOURCE_INVENTORY.ticketProductivity.dataStartRow,
    dateColumn: Object.freeze({
      sourceColumn: 'A',
      sourceIndex: 0,
      sourceHeader: 'DATE',
      targetColumn: 'report_date',
      valueType: 'date',
      required: true
    })
  }),

  destination: Object.freeze({
    tableName: 'agent_productivity',
    conflictColumns: Object.freeze([
      'report_date',
      'agent_key'
    ])
  }),

  agentBlockWidth: PRODUCTIVITY_METRICS.length,
  metrics: PRODUCTIVITY_METRICS,

  defaults: Object.freeze({
    ahtUnit: null
  })
})

export const PRODUCTIVITY_EXPECTED_COLUMN_COUNT = 28

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

function columnNumberToLetter(columnNumber) {
  let value = columnNumber
  let result = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }

  return result
}

function toAgentKey(agentName) {
  return agentName
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Derive agent blocks from the workbook headers instead of assuming specific
 * names or fixed person-to-column mappings. Any non-empty data under an
 * unnamed block, malformed metric header, or ambiguous name aborts the sync.
 */
export function getProductivityAgentBlocks(dataset) {
  const agentHeaderRow = dataset?.values?.[0]
  const metricHeaderRow = dataset?.values?.[1]

  if (!Array.isArray(agentHeaderRow) || !Array.isArray(metricHeaderRow)) {
    throw new Error(
      'Ticket Productivity must include both agent and metric header rows.'
    )
  }

  const blocks = []
  const seenNames = new Set()
  const seenKeys = new Set()
  const blockWidth = PRODUCTIVITY_MAPPING.agentBlockWidth

  for (
    let startIndex = PRODUCTIVITY_MAPPING.source.dateColumn.sourceIndex + 1;
    startIndex < PRODUCTIVITY_EXPECTED_COLUMN_COUNT;
    startIndex += blockWidth
  ) {
    const sourceNameValue = agentHeaderRow[startIndex]
    const sourceName = typeof sourceNameValue === 'string'
      ? sourceNameValue.replace(/\s+/g, ' ').trim()
      : ''
    const normalizedName = normalizeText(sourceName)
    const hasMetricHeaders = PRODUCTIVITY_MAPPING.metrics.some(
      (_metric, metricIndex) =>
        normalizeText(metricHeaderRow[startIndex + metricIndex]) !== ''
    )
    const endIndex = Math.min(
      startIndex + blockWidth,
      PRODUCTIVITY_EXPECTED_COLUMN_COUNT
    )
    const hasBlockData = (dataset.values || []).slice(2).some(row =>
      Array.isArray(row) && row
        .slice(startIndex, endIndex)
        .some(value => value !== null && value !== undefined &&
          !(typeof value === 'string' && value.trim() === ''))
    )

    if (!normalizedName) {
      const misplacedNameIndex = Array.from(
        { length: Math.max(0, endIndex - startIndex - 1) },
        (_unused, offset) => startIndex + offset + 1
      ).find(index => normalizeText(agentHeaderRow[index]))
      if (misplacedNameIndex !== undefined) {
        throw new Error(
          `Ticket Productivity agent header at column ` +
          `${columnNumberToLetter(misplacedNameIndex + 1)} is inside a ` +
          'metric block instead of starting a block.'
        )
      }
      if (hasMetricHeaders) {
        throw new Error(
          `Ticket Productivity metric block at column ` +
          `${columnNumberToLetter(startIndex + 1)} is missing its agent header.`
        )
      }
      if (hasBlockData) {
        throw new Error(
          `Ticket Productivity has data under the unnamed block at column ` +
          `${columnNumberToLetter(startIndex + 1)}.`
        )
      }
      continue
    }

    if (endIndex - startIndex !== blockWidth) {
      throw new Error(
        `Ticket Productivity agent ${sourceName} does not have a complete ` +
        `${blockWidth}-column metric block.`
      )
    }

    for (let offset = 1; offset < blockWidth; offset += 1) {
      if (normalizeText(agentHeaderRow[startIndex + offset])) {
        throw new Error(
          `Ticket Productivity agent header at column ` +
          `${columnNumberToLetter(startIndex + offset + 1)} is inside the ` +
          `metric block for ${sourceName}.`
        )
      }
    }

    PRODUCTIVITY_MAPPING.metrics.forEach((metric, metricIndex) => {
      const sourceIndex = startIndex + metricIndex
      if (
        normalizeText(metricHeaderRow[sourceIndex]) !==
        normalizeText(metric.sourceHeader)
      ) {
        throw new Error(
          `Ticket Productivity ${sourceName} column ` +
          `${columnNumberToLetter(sourceIndex + 1)} must be ` +
          `${metric.sourceHeader}.`
        )
      }
    })

    if (seenNames.has(normalizedName)) {
      throw new Error(
        `Ticket Productivity contains duplicate agent header ${sourceName}.`
      )
    }
    seenNames.add(normalizedName)

    const agentKey = toAgentKey(sourceName)
    if (!agentKey) {
      throw new Error(
        `Ticket Productivity agent header ${sourceName} cannot form a ` +
        'stable agent key.'
      )
    }
    if (seenKeys.has(agentKey)) {
      throw new Error(
        `Ticket Productivity agent headers produce a duplicate key: ` +
        `${agentKey}.`
      )
    }
    seenKeys.add(agentKey)

    blocks.push({
      agentKey,
      agentName: sourceName,
      sourceIndex: startIndex,
      metrics: PRODUCTIVITY_MAPPING.metrics.map((metric, metricIndex) => ({
        ...metric,
        sourceIndex: startIndex + metricIndex,
        sourceColumn: columnNumberToLetter(startIndex + metricIndex + 1)
      }))
    })
  }

  if (blocks.length === 0) {
    throw new Error('Ticket Productivity must include at least one agent block.')
  }

  return blocks
}
