const freezeEntries = entries => Object.freeze(
  entries.map(entry => Object.freeze({
    ...entry,
    fields: Object.freeze([...(entry.fields || [])]),
    notes: Object.freeze([...(entry.notes || [])])
  }))
)

export const PHASE3_SOURCE_SYSTEMS = Object.freeze({
  workbook: Object.freeze({
    key: 'google_workbook',
    role: 'existing_summary_source',
    authoritativeForAdvancedMetrics: false,
    notes: Object.freeze([
      'The workbook remains authoritative for the Phase 1 and Phase 2 daily summary datasets.',
      'It does not contain ticket-level timestamps, event history, SLA events, or CSAT records.',
      'Advanced response-time and SLA metrics must not be derived from workbook aggregates.'
    ])
  }),
  zendesk: Object.freeze({
    key: 'zendesk_support_api',
    role: 'authoritative_operational_source',
    authentication: 'server_side_api_token',
    requiredEnvironment: Object.freeze([
      'ZENDESK_SUBDOMAIN',
      'ZENDESK_EMAIL',
      'ZENDESK_API_TOKEN'
    ]),
    endpoints: Object.freeze({
      incrementalTickets: Object.freeze({
        method: 'GET',
        path: '/api/v2/incremental/tickets/cursor',
        purpose: 'Current ticket state and ticket-level attributes',
        initialQuery: 'start_time=<unix_timestamp>',
        recommendedInclude: 'metric_sets'
      }),
      ticketAudits: Object.freeze({
        method: 'GET',
        path: '/api/v2/tickets/{ticket_id}/audits',
        purpose: 'Timestamped ticket field changes and exact status/assignment history'
      }),
      ticketMetricEvents: Object.freeze({
        method: 'GET',
        path: '/api/v2/incremental/ticket_metric_events',
        purpose: 'SLA application, fulfillment, breach, and metric lifecycle events',
        initialQuery: 'start_time=<unix_timestamp>'
      }),
      satisfactionRatings: Object.freeze({
        method: 'GET',
        path: '/api/v2/satisfaction_ratings',
        purpose: 'Customer satisfaction ratings when CSAT is enabled'
      })
    })
  }),
  supabase: Object.freeze({
    key: 'supabase_postgres',
    role: 'normalized_storage_and_reporting_destination',
    authoritativeForSourceEvents: false,
    notes: Object.freeze([
      'Supabase stores normalized Zendesk records and derived operational metrics.',
      'Service-role access remains server-side; browser users receive read-only access.'
    ])
  })
})

export const PHASE3_ADVANCED_METRICS = freezeEntries([
  {
    key: 'first_response_time',
    label: 'First-response time',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_metrics',
    endpointKey: 'incrementalTickets',
    fields: [
      'reply_time_in_minutes.calendar',
      'reply_time_in_minutes.business'
    ],
    derivation: 'Use the Zendesk ticket metric value; do not infer it from daily aggregates.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'full_resolution_time',
    label: 'Full-resolution time',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_metrics',
    endpointKey: 'incrementalTickets',
    fields: [
      'full_resolution_time_in_minutes.calendar',
      'full_resolution_time_in_minutes.business'
    ],
    derivation: 'Use the Zendesk ticket metric value for the latest full resolution.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'ticket_age',
    label: 'Ticket age',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets',
    endpointKey: 'incrementalTickets',
    fields: ['created_at', 'status'],
    derivation: 'For active tickets, calculate now minus created_at; freeze solved-age calculations at the selected resolution timestamp.',
    availability: 'requires_zendesk_api_access',
    notes: ['Store source timestamps in UTC.']
  },
  {
    key: 'sla_breaches',
    label: 'SLA breaches',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_metric_events',
    endpointKey: 'ticketMetricEvents',
    fields: ['type', 'metric', 'time', 'deleted', 'sla'],
    derivation: 'Count non-deleted metric events whose type is breach.',
    availability: 'requires_zendesk_sla_feature',
    notes: ['A breach event marked deleted must not be counted.']
  },
  {
    key: 'assignee',
    label: 'Assignee',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets_and_audits',
    endpointKey: 'incrementalTickets',
    fields: ['assignee_id'],
    derivation: 'Use the ticket for current assignee and ticket audits for assignment history.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'priority',
    label: 'Priority',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets_and_audits',
    endpointKey: 'incrementalTickets',
    fields: ['priority'],
    derivation: 'Use the ticket for current priority and ticket audits for priority changes.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'ticket_status_changes',
    label: 'Ticket status changes',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_audits',
    endpointKey: 'ticketAudits',
    fields: [
      'created_at',
      'events.type',
      'events.field_name',
      'events.previous_value',
      'events.value'
    ],
    derivation: 'Create one normalized status-change event for each status field change in an audit.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'ticket_creation_timestamp',
    label: 'Ticket creation timestamp',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets',
    endpointKey: 'incrementalTickets',
    fields: ['created_at'],
    derivation: 'Store the source timestamp unchanged in UTC.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'ticket_resolution_timestamp',
    label: 'Ticket resolution timestamp',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_metrics_and_audits',
    endpointKey: 'incrementalTickets',
    fields: ['solved_at'],
    derivation: 'Use solved_at for the latest resolution and audits when every solved/reopened cycle is required.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'reopen_timestamp',
    label: 'Reopen timestamp',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'ticket_audits',
    endpointKey: 'ticketAudits',
    fields: [
      'created_at',
      'events.field_name',
      'events.previous_value',
      'events.value'
    ],
    derivation: 'Record the audit timestamp when status changes from solved to a non-solved working status.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'channel',
    label: 'Channel',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets',
    endpointKey: 'incrementalTickets',
    fields: ['via.channel'],
    derivation: 'Normalize the Zendesk channel value into a stable reporting key and retain the raw value.',
    availability: 'requires_zendesk_api_access',
    notes: []
  },
  {
    key: 'customer_satisfaction',
    label: 'Customer satisfaction',
    sourceSystem: 'zendesk_support_api',
    sourceResource: 'tickets_and_satisfaction_ratings',
    endpointKey: 'satisfactionRatings',
    fields: [
      'score',
      'comment',
      'reason',
      'created_at',
      'updated_at',
      'ticket_id'
    ],
    derivation: 'Store rating-level records and calculate CSAT only from eligible offered responses.',
    availability: 'requires_zendesk_csat_feature',
    notes: [
      'Do not treat unoffered or offered-without-response states as positive ratings.'
    ]
  }
])

export const PHASE3_ADVANCED_METRIC_KEYS = Object.freeze(
  PHASE3_ADVANCED_METRICS.map(metric => metric.key)
)

export function validatePhase3AdvancedDataSources() {
  const errors = []
  const expectedMetricKeys = [
    'first_response_time',
    'full_resolution_time',
    'ticket_age',
    'sla_breaches',
    'assignee',
    'priority',
    'ticket_status_changes',
    'ticket_creation_timestamp',
    'ticket_resolution_timestamp',
    'reopen_timestamp',
    'channel',
    'customer_satisfaction'
  ]

  expectedMetricKeys.forEach(metricKey => {
    const matches = PHASE3_ADVANCED_METRICS.filter(
      metric => metric.key === metricKey
    )

    if (matches.length !== 1) {
      errors.push(`Expected exactly one source mapping for ${metricKey}.`)
    }
  })

  PHASE3_ADVANCED_METRICS.forEach(metric => {
    if (metric.sourceSystem !== PHASE3_SOURCE_SYSTEMS.zendesk.key) {
      errors.push(`${metric.key} must use Zendesk as its authoritative source.`)
    }

    if (!PHASE3_SOURCE_SYSTEMS.zendesk.endpoints[metric.endpointKey]) {
      errors.push(`${metric.key} references an unknown endpoint key.`)
    }

    if (metric.fields.length === 0) {
      errors.push(`${metric.key} must declare at least one source field.`)
    }
  })

  if (PHASE3_SOURCE_SYSTEMS.workbook.authoritativeForAdvancedMetrics) {
    errors.push('The workbook must not be authoritative for advanced metrics.')
  }

  return errors
}
