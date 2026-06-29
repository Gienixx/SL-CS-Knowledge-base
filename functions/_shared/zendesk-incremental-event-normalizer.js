const TERMINAL_STATUSES = new Set(['solved', 'closed'])

function text(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null
}

function positiveId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1000000000000 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function agentKey(value) {
  const id = positiveId(value)
  return id ? `zendesk:${id}` : null
}

function eventType(previousStatus, nextStatus) {
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

function base(ticketEvent, sourceEventId, eventTimestamp) {
  const ticketId = positiveId(ticketEvent?.ticket_id)
  const sourceId = positiveId(ticketEvent?.id) || ticketId

  return {
    ticket_id: ticketId,
    event_type: null,
    event_timestamp: eventTimestamp,
    agent_key: null,
    ticket_status: null,
    priority: null,
    channel: null,
    app_key: null,
    platform_key: null,
    country_key: null,
    driver_key: null,
    source_system: 'zendesk',
    source_record_type: 'ticket_event',
    source_record_id: sourceId ? String(sourceId) : null,
    source_event_id: sourceEventId,
    metadata: {}
  }
}

export function normalizeIncrementalTicketEvent(ticketEvent) {
  const ticketId = positiveId(ticketEvent?.ticket_id)
  const parentId = positiveId(ticketEvent?.id) || ticketId
  const parentTimestamp = timestamp(
    ticketEvent?.timestamp ??
    ticketEvent?.created_at ??
    ticketEvent?.time ??
    ticketEvent?.updated_at
  )
  const children = Array.isArray(ticketEvent?.child_events)
    ? ticketEvent.child_events
    : []

  if (!ticketId || !parentTimestamp) return []

  return children.flatMap((child, index) => {
    if (text(child?.type) !== 'change') return []

    const fieldName = text(child?.field_name)
    const childId = positiveId(child?.id) || index + 1
    const auditId = positiveId(child?.audit_id)
    const sourceEventId = auditId
      ? `zendesk:audit:${auditId}:event:${childId}`
      : `zendesk:ticket_event:${parentId}:event:${childId}`
    const eventTimestamp = timestamp(child?.created_at) || parentTimestamp
    const actorId =
      child?.author_id ??
      ticketEvent?.updater_id ??
      ticketEvent?.author_id
    const common = {
      ...base(ticketEvent, sourceEventId, eventTimestamp),
      channel: text(child?.via?.channel ?? ticketEvent?.via?.channel),
      metadata: {
        actor_id: positiveId(actorId),
        field_name: fieldName
      }
    }

    if (fieldName === 'status') {
      const previousStatus = text(child?.previous_value)
      const nextStatus = text(child?.value)
      if (!nextStatus) return []

      return [{
        ...common,
        event_type: eventType(previousStatus, nextStatus),
        agent_key: agentKey(actorId),
        ticket_status: nextStatus,
        metadata: {
          ...common.metadata,
          previous_status: previousStatus,
          next_status: nextStatus
        }
      }]
    }

    if (fieldName === 'assignee_id') {
      const assigneeId = positiveId(child?.value)

      return [{
        ...common,
        event_type: 'assigned',
        agent_key: agentKey(assigneeId),
        metadata: {
          ...common.metadata,
          previous_assignee_id: positiveId(child?.previous_value),
          assignee_id: assigneeId
        }
      }]
    }

    if (fieldName === 'priority') {
      const priority = text(child?.value)
      if (!priority) return []

      return [{
        ...common,
        event_type: 'priority_changed',
        agent_key: agentKey(actorId),
        priority,
        metadata: {
          ...common.metadata,
          previous_priority: text(child?.previous_value),
          next_priority: priority
        }
      }]
    }

    return []
  })
}

export function normalizeIncrementalTicketEvents(ticketEvents) {
  const unique = new Map()

  for (const ticketEvent of ticketEvents || []) {
    for (const event of normalizeIncrementalTicketEvent(ticketEvent)) {
      unique.set(event.source_event_id, event)
    }
  }

  return [...unique.values()].sort((left, right) =>
    left.event_timestamp.localeCompare(right.event_timestamp)
  )
}
