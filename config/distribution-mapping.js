import {
  WORKBOOK_SOURCE_INVENTORY
} from './workbook-source-inventory.js'

const DISTRIBUTION_COLUMNS = Object.freeze([
  Object.freeze({
    dimensionType: 'app',
    sourceColumn: 'G',
    sourceIndex: 6,
    sourceHeader: 'EUREKA',
    dimensionKey: 'eureka',
    dimensionLabel: 'Eureka'
  }),
  Object.freeze({
    dimensionType: 'app',
    sourceColumn: 'H',
    sourceIndex: 7,
    sourceHeader: 'SURVEY POP',
    dimensionKey: 'survey_pop',
    dimensionLabel: 'SurveyPop'
  }),
  Object.freeze({
    dimensionType: 'app',
    sourceColumn: 'I',
    sourceIndex: 8,
    sourceHeader: 'SURVEY SPIN',
    dimensionKey: 'survey_spin',
    dimensionLabel: 'SurveySpin'
  }),
  Object.freeze({
    dimensionType: 'platform',
    sourceColumn: 'J',
    sourceIndex: 9,
    sourceHeader: 'iOS',
    dimensionKey: 'ios',
    dimensionLabel: 'iOS'
  }),
  Object.freeze({
    dimensionType: 'platform',
    sourceColumn: 'K',
    sourceIndex: 10,
    sourceHeader: 'Android',
    dimensionKey: 'android',
    dimensionLabel: 'Android'
  }),
  Object.freeze({
    dimensionType: 'platform',
    sourceColumn: 'L',
    sourceIndex: 11,
    sourceHeader: 'Web',
    dimensionKey: 'web',
    dimensionLabel: 'Web'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'M',
    sourceIndex: 12,
    sourceHeader: 'Australia (AU)',
    dimensionKey: 'au',
    dimensionLabel: 'Australia'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'N',
    sourceIndex: 13,
    sourceHeader: 'Canada (CA)',
    dimensionKey: 'ca',
    dimensionLabel: 'Canada'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'O',
    sourceIndex: 14,
    sourceHeader: 'France (FR)',
    dimensionKey: 'fr',
    dimensionLabel: 'France'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'P',
    sourceIndex: 15,
    sourceHeader: 'Germany (DE)',
    dimensionKey: 'de',
    dimensionLabel: 'Germany'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'Q',
    sourceIndex: 16,
    sourceHeader: 'UK (GB)',
    dimensionKey: 'gb',
    dimensionLabel: 'United Kingdom'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'R',
    sourceIndex: 17,
    sourceHeader: 'USA (US)',
    dimensionKey: 'us',
    dimensionLabel: 'United States'
  }),
  Object.freeze({
    dimensionType: 'country',
    sourceColumn: 'S',
    sourceIndex: 18,
    sourceHeader: 'UNKNOWN',
    dimensionKey: 'unknown',
    dimensionLabel: 'Unknown'
  })
])

export const DISTRIBUTION_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: WORKBOOK_SOURCE_INVENTORY.dailyVolume.sheetName,
    range: "'Daily Volume '!A:S",
    headerRow: 1,
    dataStartRow:
      WORKBOOK_SOURCE_INVENTORY.dailyVolume.dataStartRow,
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
    tableName: 'daily_distribution_metrics',
    conflictColumns: Object.freeze([
      'report_date',
      'dimension_type',
      'dimension_key'
    ])
  }),

  columns: DISTRIBUTION_COLUMNS
})

export const DISTRIBUTION_TYPES = Object.freeze([
  'app',
  'platform',
  'country'
])

export const DISTRIBUTION_REQUIRED_SOURCE_HEADERS = Object.freeze([
  DISTRIBUTION_MAPPING.source.dateColumn.sourceHeader,
  ...DISTRIBUTION_COLUMNS.map(column => column.sourceHeader)
])

function normalizeHeader(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

export function findDistributionBySourceHeader(header) {
  const normalizedHeader = normalizeHeader(header)

  return DISTRIBUTION_COLUMNS.find(
    column =>
      normalizeHeader(column.sourceHeader) === normalizedHeader
  ) || null
}

export function findDistributionBySourceIndex(sourceIndex) {
  return DISTRIBUTION_COLUMNS.find(
    column => column.sourceIndex === sourceIndex
  ) || null
}
