function normalizeText(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null
}

function normalizeTicketId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function normalizeSourceId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return null
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  if (typeof value !== 'string' || !value.trim()) return null

  const numeric = Number(value)
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return normalizeTimestamp(numeric)
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeOptionalId(value) {
  const sourceId = normalizeSourceId(value)
  return sourceId || null
}

function safeSlaMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const id = normalizeOptionalId(value.id)
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim().slice(0, 200)
    : null

  if (!id && !title) return null
  return { id, title }
}

function buildFallbackSourceId(event, ticketId, metric, timestamp) {
  const instanceId = normalizeOptionalId(event?.instance_id) || 'none'
  return `ticket:${ticketId}:metric:${metric}:instance:${instanceId}:time:${timestamp}`
}

export function normalizeSlaMetricEvent(event) {
  const eventType = normalizeText(event?.type || event?.event_type)
  const deleted = event?.deleted === true || event?.deleted === 1 || event?.deleted === 'true'

  if (eventType !== 'breach' || deleted) return null

  const ticketId = normalizeTicketId(event?.ticket_id)
  const metric = normalizeText(event?.metric)
  const timestamp = normalizeTimestamp(
    event?.time || event?.created_at || event?.updated_at
  )

  if (!ticketId || !metric || !timestamp) return null

  const sourceRecordId = normalizeSourceId(event?.id) ||
    buildFallbackSourceId(event, ticketId, metric, timestamp)

  return {
    ticket_id: ticketId,
    source_event_id: `zendesk:ticket_metric_event:${sourceRecordId}`,
    event_type: 'sla_breached',
    event_timestamp: timestamp,
    agent_key: null,
    ticket_status: null,
    priority: null,
    channel: null,
    app_key: null,
    platform_key: null,
    country_key: null,
    driver_key: null,
    source_system: 'zendesk',
    source_record_type: 'ticket_metric_event',
    source_record_id: sourceRecordId,
    metadata: {
      metric,
      instance_id: normalizeOptionalId(event?.instance_id),
      business_hours: event?.business_hours === true,
      sla: safeSlaMetadata(event?.sla)
    }
  }
}

export function normalizeSlaMetricEvents(events) {
  const unique = new Map()

  for (const sourceEvent of Array.isArray(events) ? events : []) {
    const event = normalizeSlaMetricEvent(sourceEvent)
    if (event) unique.set(event.source_event_id, event)
  }

  return [...unique.values()].sort((left, right) =>
    left.event_timestamp.localeCompare(right.event_timestamp)
  )
}
