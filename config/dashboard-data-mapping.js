const DAILY_VOLUME_COLUMNS = [
  {
    sourceHeader: 'DATE',
    targetColumn: 'report_date',
    valueType: 'date',
    required: true
  },
  {
    sourceHeader: 'New',
    targetColumn: 'new_tickets',
    valueType: 'integer',
    required: true
  },
  {
    sourceHeader: 'Unsolved',
    targetColumn: 'unsolved_tickets',
    valueType: 'integer',
    required: true
  },
  {
    sourceHeader: 'Solved',
    targetColumn: 'solved_tickets',
    valueType: 'integer',
    required: true
  },
  {
    sourceHeader: 'One \nTouch Resolution',
    sourceHeaderAliases: [
      'One Touch Resolution'
    ],
    targetColumn: 'one_touch_resolution',
    valueType: 'percentage',
    required: true
  },
  {
    sourceHeader: 'Reopened',
    targetColumn: 'reopened_rate',
    valueType: 'percentage',
    required: true
  }
]

export const PHASE_ONE_DASHBOARD_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: 'Daily Volume ',
    range: "'Daily Volume '!A:F",
    headerRow: 1
  }),

  destination: Object.freeze({
    tableName: 'daily_ticket_metrics',
    conflictColumn: 'report_date'
  }),

  columns: Object.freeze(
    DAILY_VOLUME_COLUMNS.map(column =>
      Object.freeze({
        ...column,
        sourceHeaderAliases: Object.freeze(
          column.sourceHeaderAliases || []
        )
      })
    )
  )
})

export const PHASE_ONE_REQUIRED_SOURCE_HEADERS = Object.freeze(
  PHASE_ONE_DASHBOARD_MAPPING.columns
    .filter(column => column.required)
    .map(column => column.sourceHeader)
)

export const PHASE_ONE_REQUIRED_DATABASE_COLUMNS = Object.freeze(
  PHASE_ONE_DASHBOARD_MAPPING.columns
    .filter(column => column.required)
    .map(column => column.targetColumn)
)

export function findPhaseOneColumnBySourceHeader(header) {
  if (typeof header !== 'string') {
    return null
  }

  const normalizedHeader = header
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  return PHASE_ONE_DASHBOARD_MAPPING.columns.find(column => {
    const acceptedHeaders = [
      column.sourceHeader,
      ...column.sourceHeaderAliases
    ]

    return acceptedHeaders.some(acceptedHeader =>
      acceptedHeader
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase() === normalizedHeader
    )
  }) || null
}

// total_ticket_concerns is intentionally not mapped in Phase 1 because it is
// sourced from the Daily Drivers worksheet, which belongs to the later
// ticket-driver implementation phase.
