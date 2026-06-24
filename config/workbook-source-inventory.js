const freezeEntries = entries => Object.freeze(
  entries.map(entry => Object.freeze({ ...entry }))
)

export const WORKBOOK_SOURCE_INVENTORY = Object.freeze({
  dailyVolume: Object.freeze({
    sheetName: 'Daily Volume ',
    usedRange: 'A1:S366',
    headerRows: Object.freeze([1]),
    dataStartRow: 2,
    dateColumn: 'A',
    baseMetricsRange: 'B:F',
    distributions: Object.freeze({
      apps: Object.freeze({
        range: 'G:I',
        headers: Object.freeze([
          'EUREKA',
          'SURVEY POP',
          'SURVEY SPIN'
        ])
      }),
      platforms: Object.freeze({
        range: 'J:L',
        headers: Object.freeze([
          'iOS',
          'Android',
          'Web'
        ])
      }),
      countries: Object.freeze({
        range: 'M:S',
        headers: Object.freeze([
          'Australia (AU)',
          'Canada (CA)',
          'France (FR)',
          'Germany (DE)',
          'UK (GB)',
          'USA (US)',
          'UNKNOWN'
        ])
      })
    })
  }),

  ticketProductivity: Object.freeze({
    sheetName: 'Ticket Productivity',
    usedRange: 'A1:Y367',
    headerRows: Object.freeze([1, 2]),
    dataStartRow: 3,
    dateColumn: 'A',
    metricOrder: Object.freeze([
      'Solved Ticket',
      'Open Tickets',
      'AHT'
    ]),
    agentBlocks: freezeEntries([
      { agentName: 'Amora', range: 'B:D' },
      { agentName: 'Ford', range: 'E:G' },
      { agentName: 'Gen', range: 'H:J' },
      { agentName: 'Arez', range: 'K:M' },
      { agentName: 'Tristan', range: 'N:P' },
      { agentName: 'Jerson', range: 'Q:S' },
      { agentName: 'Jean', range: 'T:V' },
      { agentName: 'Arby', range: 'W:Y' }
    ]),
    notes: Object.freeze([
      'Agent names occupy the first column of each three-column block.',
      'The following two cells in each row-one block are blank by design.',
      'AHT is numeric in the source, but its unit must be confirmed before labeling it in the dashboard.',
      'Blank Open Tickets cells must remain null rather than being converted to zero.'
    ])
  }),

  dailyDrivers: Object.freeze({
    sheetName: 'Daily Drivers',
    usedRange: 'A1:CD367',
    headerRows: Object.freeze([1, 2]),
    dataStartRow: 3,
    dateColumn: 'A',
    stableKeyRow: 1,
    displayLabelRow: 2,
    detailRange: 'B:BU',
    detailColumnCount: 72,
    driverGroups: freezeEntries([
      {
        key: 'survey',
        label: 'Survey',
        detailRange: 'B:L',
        summaryColumn: 'BV',
        concernCount: 11
      },
      {
        key: 'cashout',
        label: 'Cashout',
        detailRange: 'M:AH',
        summaryColumn: 'BW',
        concernCount: 22
      },
      {
        key: 'login',
        label: 'Login',
        detailRange: 'AI:AL',
        summaryColumn: 'BX',
        concernCount: 4
      },
      {
        key: 'paid_offers_promos',
        label: 'Paid Offers & Promos',
        detailRange: 'AM:AX',
        summaryColumn: 'BY',
        concernCount: 12
      },
      {
        key: 'user_profile',
        label: 'User Profile',
        detailRange: 'AY:BA',
        summaryColumn: 'BZ',
        concernCount: 3
      },
      {
        key: 'suggestions',
        label: 'Suggestions',
        detailRange: 'BB:BB',
        summaryColumn: 'CA',
        concernCount: 1
      },
      {
        key: 'fraud_control',
        label: 'Fraud Control',
        detailRange: 'BC:BO',
        summaryColumn: 'CB',
        concernCount: 13
      },
      {
        key: 'others',
        label: 'Others',
        detailRange: 'BP:BU',
        summaryColumn: 'CC',
        concernCount: 6
      }
    ]),
    summaryRange: 'BV:CC',
    dailyTotalColumn: 'CD',
    notes: Object.freeze([
      'Columns BV:CD contain worksheet formulas and are not authoritative import sources.',
      'Future dated rows can contain calculated zero or blank summaries even when B:BU has no source data.',
      'The importer must determine row completeness from B:BU, not from BV:CD.',
      'Row one provides stable machine keys and row two provides user-facing labels.'
    ])
  }),

  excludedWorksheets: freezeEntries([
    {
      sheetName: 'MTD YTD',
      reason: 'Not required for normalized daily dashboard datasets.'
    },
    {
      sheetName: 'Driver Summary ',
      reason: 'Contains dates but no populated driver totals in the supplied workbook; totals will be derived from Daily Drivers.'
    }
  ])
})

export const REQUIRED_WORKBOOK_SHEETS = Object.freeze([
  WORKBOOK_SOURCE_INVENTORY.dailyVolume.sheetName,
  WORKBOOK_SOURCE_INVENTORY.ticketProductivity.sheetName,
  WORKBOOK_SOURCE_INVENTORY.dailyDrivers.sheetName
])
