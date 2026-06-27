const TERMINAL_STATUSES = new Set(['solved', 'closed'])

function normalizeText(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null
}

function normalizeId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function toAgentKey(value) {
  const id = normalizeId(value)
  return id ? `zendesk:${id}` : null
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function numericMetric(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function baseEvent(ticket, overrides = {}) {
  const ticketId = normalizeId(ticket?.id)

  return {
    ticket_id: ticketId,
    event_type: null,
    event_timestamp: null,
    agent_key: toAgentKey(ticket?.assignee_id),
    ticket_status: normalizeText(ticket?.status),
    priority: normalizeText(ticket?.priority),
    channel: normalizeText(ticket?.via?.channel),
    app_key: null,
    platform_key: null,
    country_key: null,
    driver_key: null,
    source_system: 'zendesk',
    source_record_type: 'ticket',
    source_record_id: ticketId ? String(ticketId) : null,
    source_event_id: null,
    metadata: {},
    ...overrides
  }
}

export function buildTicketEvents(ticket, metricSet = null) {
  const ticketId = normalizeId(ticket?.id)
  const createdAt = normalizeTimestamp(ticket?.created_at)

  if (!ticketId || !createdAt) return []

  const events = [baseEvent(ticket, {
    event_type: 'created',
    event_timestamp: createdAt,
    source_event_id: `zendesk:ticket:${ticketId}:created`,
    metadata: {
      group_id: normalizeId(ticket?.group_id)
    }
  })]
  const calendarMinutes = numericMetric(
    metricSet?.reply_time_in_minutes?.calendar
  )

  if (calendarMinutes !== null) {
    const firstResponseAt = new Date(
      new Date(createdAt).getTime() + calendarMinutes * 60 * 1000
    ).toISOString()

    events.push(baseEvent(ticket, {
      event_type: 'first_response',
      event_timestamp: firstResponseAt,
      agent_key: null,
      source_record_type: 'ticket_metric',
      source_record_id: String(metricSet?.id || ticketId),
      source_event_id: `zendesk:ticket:${ticketId}:first_response`,
      metadata: {
        calendar_minutes: calendarMinutes,
        business_minutes: numericMetric(
          metricSet?.reply_time_in_minutes?.business
        )
      }
    }))
  }

  return events
}

function statusEventType(previousStatus, nextStatus) {
  if (nextStatus === 'closed') return 'closed'
  if (nextStatus === 'solved') return 'solved'

  if (
    TERMINAL_STATUSES.has(previousStatus) &&
    !TERMINAL_STATUSES.has(nextStatus)
  ) {
    return 'reopened'
  }

  return 'status_changed'
}

export function buildAuditEvents(ticket, audits) {
  if (!Array.isArray(audits)) return []

  return audits.flatMap(audit => {
    const timestamp = normalizeTimestamp(audit?.created_at)
    const auditId = normalizeId(audit?.id)

    if (!timestamp || !auditId || !Array.isArray(audit?.events)) return []

    return audit.events.flatMap((event, index) => {
      if (normalizeText(event?.type) !== 'change') return []

      const fieldName = normalizeText(event?.field_name)
      const eventId = normalizeId(event?.id) || index + 1
      const common = {
        event_timestamp: timestamp,
        source_record_type: 'ticket_audit',
        source_record_id: String(auditId),
        source_event_id: `zendesk:audit:${auditId}:event:${eventId}`,
        metadata: {
          actor_id: normalizeId(audit?.author_id),
          field_name: fieldName
        }
      }

      if (fieldName === 'status') {
        const previousStatus = normalizeText(event?.previous_value)
        const nextStatus = normalizeText(event?.value)

        if (!nextStatus) return []

        return [baseEvent(ticket, {
          ...common,
          event_type: statusEventType(previousStatus, nextStatus),
          agent_key: toAgentKey(audit?.author_id),
          ticket_status: nextStatus,
          metadata: {
            ...common.metadata,
            previous_status: previousStatus,
            next_status: nextStatus
          }
        })]
      }

      if (fieldName === 'assignee_id') {
        const assigneeId = normalizeId(event?.value)

        return [baseEvent(ticket, {
          ...common,
          event_type: 'assigned',
          agent_key: toAgentKey(assigneeId),
          metadata: {
            ...common.metadata,
            previous_assignee_id: normalizeId(event?.previous_value),
            assignee_id: assigneeId
          }
        })]
      }

      if (fieldName === 'priority') {
        const priority = normalizeText(event?.value)

        if (!priority) return []

        return [baseEvent(ticket, {
          ...common,
          event_type: 'priority_changed',
          agent_key: toAgentKey(audit?.author_id),
          priority,
          metadata: {
            ...common.metadata,
            previous_priority: normalizeText(event?.previous_value),
            next_priority: priority
          }
        })]
      }

      return []
    })
  })
}

export function deduplicateTicketEvents(events) {
  const unique = new Map()

  for (const event of events || []) {
    if (
      event?.ticket_id &&
      event?.source_event_id &&
      event?.event_type &&
      event?.event_timestamp
    ) {
      unique.set(event.source_event_id, event)
    }
  }

  return [...unique.values()].sort((left, right) =>
    left.event_timestamp.localeCompare(right.event_timestamp)
  )
}

export function findMetricSet(metricSets, ticketId) {
  if (!Array.isArray(metricSets)) return null

  return metricSets.find(metricSet =>
    normalizeId(metricSet?.ticket_id) === normalizeId(ticketId)
  ) || null
}
