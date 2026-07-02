export const PHASE3_STEP9_CONTRACT_VERSION = 3
export const PHASE3_STEP9_CONTRACT_KEY =
  'phase3_step9_google_sheet_reporting'
export const PHASE3_STEP9_LEGACY_PRODUCTIVITY_SHEET_NAME =
  'Ticket Productivity'
export const PHASE3_STEP9_PRODUCTIVITY_SHEET_NAME =
  'Ticket Productivity V3'

const column = (
  name,
  dataType,
  definition,
  validationRule,
  required = true
) => Object.freeze({
  name,
  dataType,
  required,
  definition,
  validationRule
})

export const PHASE3_STEP9_ALLOWED_DIMENSION_TYPES = Object.freeze([
  'app',
  'platform',
  'country',
  'concern',
  'priority',
  'channel'
])

export const PHASE3_STEP9_TABS = Object.freeze({
  dailyTicketMetrics: Object.freeze({
    datasetKey: 'dailyTicketMetrics',
    sheetName: 'Daily Ticket Metrics',
    columns: Object.freeze([
      column('report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'),
      column('new_tickets', 'integer', 'Tickets created during the reporting date.', 'Non-negative integer.'),
      column('solved_tickets', 'integer', 'Tickets solved during the reporting date.', 'Non-negative integer; must equal the agent total.'),
      column('unsolved_tickets', 'integer', 'Open backlog snapshot for the reporting date.', 'Non-negative integer.'),
      column('one_touch_resolution', 'number', 'Share of resolved tickets completed in one touch.', 'Decimal from 0 through 1; must equal one_touch_tickets / resolved_tickets.'),
      column('reopened_rate', 'number', 'Share of resolved tickets that reopened.', 'Decimal from 0 through 1; must equal reopened_tickets / resolved_tickets.'),
      column('responded_tickets', 'integer', 'Tickets that received a first response.', 'Non-negative integer; must equal the agent total.'),
      column('first_response_minutes_total', 'number', 'Total first-response minutes for responded tickets.', 'Non-negative number; must equal the agent total.'),
      column('first_response_median_minutes', 'number', 'Median first-response minutes for the team.', 'Non-negative number.'),
      column('resolved_tickets', 'integer', 'Tickets with a completed resolution.', 'Non-negative integer; must equal the agent total.'),
      column('resolution_minutes_total', 'number', 'Total resolution minutes for resolved tickets.', 'Non-negative number; must equal the agent total.'),
      column('resolution_median_minutes', 'number', 'Median resolution minutes for the team.', 'Non-negative number.'),
      column('reopened_tickets', 'integer', 'Resolved tickets that reopened.', 'Non-negative integer; must equal the agent total.'),
      column('one_touch_tickets', 'integer', 'Resolved tickets completed in one touch.', 'Non-negative integer; must equal the agent total.')
    ])
  }),
  ticketProductivity: Object.freeze({
    datasetKey: 'ticketProductivity',
    sheetName: PHASE3_STEP9_PRODUCTIVITY_SHEET_NAME,
    columns: Object.freeze([
      column('report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'),
      column('agent_key', 'key', 'Stable machine-readable agent identifier.', 'Lowercase letters, numbers, underscores, and hyphens only; never reuse for another person.'),
      column('agent_name', 'text', 'Current display name for the agent.', 'Non-empty text; one name per agent_key in the test window.'),
      column('solved_tickets', 'integer', 'Tickets solved by the agent.', 'Non-negative integer.'),
      column('open_tickets', 'integer', 'Open tickets assigned to the agent.', 'Non-negative integer.'),
      column('handled_tickets', 'integer', 'Tickets handled by the agent.', 'Non-negative integer.'),
      column('handle_minutes_total', 'number', 'Total handle minutes for handled tickets.', 'Non-negative number.'),
      column('responded_tickets', 'integer', 'Tickets receiving a first response from the agent.', 'Non-negative integer; cannot exceed handled_tickets.'),
      column('first_response_minutes_total', 'number', 'Total first-response minutes for responded tickets.', 'Non-negative number.'),
      column('first_response_median_minutes', 'number', 'Median first-response minutes for the agent.', 'Non-negative number.'),
      column('resolved_tickets', 'integer', 'Tickets resolved by the agent.', 'Non-negative integer; cannot exceed handled_tickets.'),
      column('resolution_minutes_total', 'number', 'Total resolution minutes for resolved tickets.', 'Non-negative number.'),
      column('resolution_median_minutes', 'number', 'Median resolution minutes for the agent.', 'Non-negative number.'),
      column('reopened_tickets', 'integer', 'Resolved tickets that reopened for the agent.', 'Non-negative integer.'),
      column('one_touch_tickets', 'integer', 'Resolved tickets completed in one touch by the agent.', 'Non-negative integer; cannot exceed resolved_tickets.'),
      column('worked_hours', 'number', 'Hours worked by the agent during the reporting date.', 'Non-negative number.')
    ])
  }),
  agentDimensionMetrics: Object.freeze({
    datasetKey: 'agentDimensionMetrics',
    sheetName: 'Agent Dimension Metrics',
    columns: Object.freeze([
      column('report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'),
      column('agent_key', 'key', 'Stable machine-readable agent identifier.', 'Must match Ticket Productivity V3.'),
      column('agent_name', 'text', 'Current display name for the agent.', 'Must match Ticket Productivity V3 for agent_key.'),
      column('dimension_type', 'enum', 'Reporting dimension represented by the row.', 'One of app, platform, country, concern, priority, or channel.'),
      column('dimension_key', 'key', 'Stable machine-readable dimension value.', 'Lowercase key; use unknown when the source value is missing.'),
      column('dimension_label', 'text', 'Display label for the dimension value.', 'Non-empty text.'),
      column('ticket_count', 'integer', 'Handled-ticket count for the dimension value.', 'Non-negative integer.')
    ])
  }),
  dataDictionary: Object.freeze({
    datasetKey: 'dataDictionary',
    sheetName: 'Data Dictionary',
    columns: Object.freeze([
      column('tab_name', 'text', 'Workbook tab containing the documented column.', 'Must match a Step 9 tab name.'),
      column('column_name', 'text', 'Exact machine-readable column header.', 'Must match the Step 9 contract.'),
      column('data_type', 'text', 'Expected logical data type.', 'Must match the Step 9 contract.'),
      column('required', 'boolean', 'Whether every imported row requires a value.', 'TRUE or FALSE.'),
      column('definition', 'text', 'Business definition for the column.', 'Non-empty text.'),
      column('validation_rule', 'text', 'Human-readable validation rule.', 'Non-empty text.')
    ])
  }),
  syncMetadata: Object.freeze({
    datasetKey: 'syncMetadata',
    sheetName: 'Sync Metadata',
    columns: Object.freeze([
      column('contract_version', 'integer', 'Google Sheet reporting contract version.', 'Must equal 3.'),
      column('generated_at', 'datetime', 'Time the payload was generated.', 'ISO-8601 date and time.'),
      column('source_time_zone', 'text', 'Workbook reporting time zone.', 'Must equal America/New_York.'),
      column('test_window_start', 'date', 'First date included in the validation window.', 'ISO date YYYY-MM-DD.'),
      column('test_window_end', 'date', 'Last date included in the validation window.', 'ISO date YYYY-MM-DD and not before test_window_start.'),
      column('test_days_count', 'integer', 'Number of distinct reporting dates in the validation window.', 'Positive integer; production readiness requires at least 7.'),
      column('producer', 'text', 'Name of the process producing the payload.', 'Non-empty text.')
    ])
  })
})

export const PHASE3_STEP9_REQUIRED_DATASET_KEYS = Object.freeze(
  Object.values(PHASE3_STEP9_TABS).map(tab => tab.datasetKey)
)

export function getPhase3Step9ExpectedDictionaryRows() {
  return Object.values(PHASE3_STEP9_TABS).flatMap(tab =>
    tab.columns.map(definition => Object.freeze({
      tab_name: tab.sheetName,
      column_name: definition.name,
      data_type: definition.dataType,
      required: definition.required,
      definition: definition.definition,
      validation_rule: definition.validationRule
    }))
  )
}

export function validatePhase3Step9ContractDefinition() {
  const errors = []
  const datasetKeys = new Set()
  const sheetNames = new Set()

  Object.values(PHASE3_STEP9_TABS).forEach(tab => {
    if (datasetKeys.has(tab.datasetKey)) {
      errors.push(`Duplicate dataset key: ${tab.datasetKey}.`)
    }
    datasetKeys.add(tab.datasetKey)

    if (sheetNames.has(tab.sheetName)) {
      errors.push(`Duplicate sheet name: ${tab.sheetName}.`)
    }
    sheetNames.add(tab.sheetName)

    const columnNames = new Set()
    tab.columns.forEach(definition => {
      if (columnNames.has(definition.name)) {
        errors.push(
          `Duplicate column ${definition.name} in ${tab.sheetName}.`
        )
      }
      columnNames.add(definition.name)
    })
  })

  if (
    PHASE3_STEP9_TABS.ticketProductivity.sheetName ===
    PHASE3_STEP9_LEGACY_PRODUCTIVITY_SHEET_NAME
  ) {
    errors.push(
      'The Step 9 productivity tab must not reuse the legacy tab name.'
    )
  }

  return errors
}
