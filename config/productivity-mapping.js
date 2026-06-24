import {
  WORKBOOK_SOURCE_INVENTORY
} from './workbook-source-inventory.js'

const PRODUCTIVITY_AGENTS = Object.freeze([
  Object.freeze({
    agentKey: 'amora',
    agentName: 'Amora',
    sourceName: 'Amora ',
    sourceNameAliases: Object.freeze(['Amora']),
    sourceRange: 'B:D',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'B',
        sourceIndex: 1,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'C',
        sourceIndex: 2,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'D',
        sourceIndex: 3,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'ford',
    agentName: 'Ford',
    sourceName: 'Ford',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'E:G',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'E',
        sourceIndex: 4,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'F',
        sourceIndex: 5,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'G',
        sourceIndex: 6,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'gen',
    agentName: 'Gen',
    sourceName: 'Gen',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'H:J',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'H',
        sourceIndex: 7,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'I',
        sourceIndex: 8,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'J',
        sourceIndex: 9,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'arez',
    agentName: 'Arez',
    sourceName: 'Arez',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'K:M',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'K',
        sourceIndex: 10,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'L',
        sourceIndex: 11,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'M',
        sourceIndex: 12,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'tristan',
    agentName: 'Tristan',
    sourceName: 'Tristan',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'N:P',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'N',
        sourceIndex: 13,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'O',
        sourceIndex: 14,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'P',
        sourceIndex: 15,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'jerson',
    agentName: 'Jerson',
    sourceName: 'Jerson',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'Q:S',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'Q',
        sourceIndex: 16,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'R',
        sourceIndex: 17,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'S',
        sourceIndex: 18,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'jean',
    agentName: 'Jean',
    sourceName: 'Jean',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'T:V',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'T',
        sourceIndex: 19,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'U',
        sourceIndex: 20,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'V',
        sourceIndex: 21,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: 'arby',
    agentName: 'Arby',
    sourceName: 'Arby',
    sourceNameAliases: Object.freeze([]),
    sourceRange: 'W:Y',
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: 'W',
        sourceIndex: 22,
        sourceHeader: 'Solved Ticket',
        targetColumn: 'solved_tickets',
        valueType: 'integer',
        nullable: false
      }),
      Object.freeze({
        sourceColumn: 'X',
        sourceIndex: 23,
        sourceHeader: 'Open Tickets',
        targetColumn: 'open_tickets',
        valueType: 'integer',
        nullable: true
      }),
      Object.freeze({
        sourceColumn: 'Y',
        sourceIndex: 24,
        sourceHeader: 'AHT',
        targetColumn: 'aht_value',
        valueType: 'number',
        nullable: true
      })
    ])
  })
])

export const PRODUCTIVITY_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName:
      WORKBOOK_SOURCE_INVENTORY.ticketProductivity.sheetName,
    range: "'Ticket Productivity'!A:Y",
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

  agents: PRODUCTIVITY_AGENTS,

  defaults: Object.freeze({
    ahtUnit: null
  })
})

export const PRODUCTIVITY_AGENT_KEYS = Object.freeze(
  PRODUCTIVITY_AGENTS.map(agent => agent.agentKey)
)

export const PRODUCTIVITY_EXPECTED_COLUMN_COUNT = 25

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

export function findProductivityAgentBySourceName(sourceName) {
  const normalizedName = normalizeText(sourceName)

  return PRODUCTIVITY_AGENTS.find(agent => {
    const acceptedNames = [
      agent.sourceName,
      ...agent.sourceNameAliases
    ]

    return acceptedNames.some(
      name => normalizeText(name) === normalizedName
    )
  }) || null
}

export function findProductivityAgentByKey(agentKey) {
  return PRODUCTIVITY_AGENTS.find(
    agent => agent.agentKey === agentKey
  ) || null
}
