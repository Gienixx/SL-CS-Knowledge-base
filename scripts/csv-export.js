const PAGE_SIZE = 1000

export const CSV_DATASETS = Object.freeze({
  daily_ticket_metrics: Object.freeze({
    label: 'Daily ticket metrics',
    columns: 'report_date, new_tickets, solved_tickets, unsolved_tickets, one_touch_resolution, reopened_rate, responded_tickets, first_response_minutes_total, first_response_median_minutes, resolved_tickets, resolution_minutes_total, resolution_median_minutes, reopened_tickets, one_touch_tickets, updated_at',
    dateColumn: 'report_date'
  }),
  daily_distribution_metrics: Object.freeze({
    label: 'Daily distributions',
    columns: 'report_date, dimension_type, dimension_key, dimension_label, ticket_count, updated_at',
    dateColumn: 'report_date'
  }),
  agent_productivity: Object.freeze({
    label: 'Agent productivity',
    columns: 'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value, handled_tickets, handle_minutes_total, responded_tickets, first_response_minutes_total, first_response_median_minutes, resolved_tickets, resolution_minutes_total, resolution_median_minutes, reopened_tickets, one_touch_tickets, worked_hours, updated_at',
    dateColumn: 'report_date'
  }),
  ticket_driver_metrics: Object.freeze({
    label: 'Ticket drivers',
    columns: 'report_date, driver_key, driver_label, driver_group_key, driver_group_label, ticket_count, updated_at',
    dateColumn: 'report_date'
  }),
  agent_dimension_metrics: Object.freeze({
    label: 'Agent dimensions',
    columns: 'report_date, agent_key, agent_name, dimension_type, dimension_key, dimension_label, ticket_count, updated_at',
    dateColumn: 'report_date'
  }),
  dashboard_sync_runs: Object.freeze({
    label: 'Synchronization history',
    columns: 'id, started_at, completed_at, status, report_date, rows_imported, error_message, sync_source, reporting_source, quality_status',
    dateColumn: 'started_at',
    timestampFilter: true
  }),
  dashboard_data_quality_results: Object.freeze({
    label: 'Data-quality results',
    columns: 'id, sync_run_id, check_key, status, observed_value, details, checked_at',
    dateColumn: 'checked_at',
    timestampFilter: true
  }),
  dashboard_alert_events: Object.freeze({
    label: 'Alert history',
    columns: 'id, alert_key, alert_type, severity, status, title, message, sync_run_id, metadata, created_at, resolved_at',
    dateColumn: 'created_at',
    timestampFilter: true
  }),
  dashboard_audit_events: Object.freeze({
    label: 'Audit history',
    columns: 'id, event_key, event_type, severity, title, details, sync_run_id, actor_email, metadata, created_at',
    dateColumn: 'created_at',
    timestampFilter: true
  })
})

function filterBoundary(value, end, timestamp) {
  if (!value) return null
  if (!timestamp) return value
  return `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`
}

function csvValue(value) {
  if (value === null || value === undefined) return ''
  const normalized = typeof value === 'object'
    ? JSON.stringify(value)
    : String(value)
  if (!/[",\n\r]/.test(normalized)) return normalized
  return `"${normalized.replaceAll('"', '""')}"`
}

function toCsv(rows) {
  if (!rows.length) return ''
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const lines = [headers.map(csvValue).join(',')]
  rows.forEach(row => {
    lines.push(headers.map(header => csvValue(row[header])).join(','))
  })
  return `${lines.join('\r\n')}\r\n`
}

function safeFilenamePart(value) {
  return String(value || 'all').replace(/[^a-z0-9_-]+/gi, '-')
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportCsvDataset(supabase, datasetKey, startDate = '', endDate = '') {
  const config = CSV_DATASETS[datasetKey]
  if (!config) throw new Error('Choose a supported CSV export dataset.')
  if (startDate && endDate && startDate > endDate) {
    throw new Error('The export start date cannot be after the end date.')
  }

  const rows = []
  let offset = 0

  while (true) {
    let query = supabase
      .from(datasetKey)
      .select(config.columns)
      .order(config.dateColumn, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    const startBoundary = filterBoundary(startDate, false, config.timestampFilter)
    const endBoundary = filterBoundary(endDate, true, config.timestampFilter)
    if (startBoundary) query = query.gte(config.dateColumn, startBoundary)
    if (endBoundary) query = query.lte(config.dateColumn, endBoundary)

    const { data, error } = await query
    if (error) throw error
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = [
    safeFilenamePart(datasetKey),
    safeFilenamePart(startDate || 'all'),
    safeFilenamePart(endDate || 'all'),
    timestamp
  ].join('_') + '.csv'

  downloadCsv(toCsv(rows), filename)
  return { rowCount: rows.length, filename, label: config.label }
}
