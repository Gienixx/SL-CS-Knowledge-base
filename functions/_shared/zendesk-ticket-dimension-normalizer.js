const FIELD_ENVIRONMENT_KEYS = Object.freeze({
  app: ['ZENDESK_APP_CUSTOM_FIELD_ID', 'ZENDESK_APP_FIELD_ID'],
  platform: ['ZENDESK_PLATFORM_CUSTOM_FIELD_ID', 'ZENDESK_PLATFORM_FIELD_ID'],
  country: ['ZENDESK_COUNTRY_CUSTOM_FIELD_ID', 'ZENDESK_COUNTRY_FIELD_ID'],
  concern: ['ZENDESK_CONCERN_CUSTOM_FIELD_ID', 'ZENDESK_CONCERN_FIELD_ID']
})

function positiveId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function firstConfiguredId(environment, keys) {
  for (const key of keys) {
    const id = positiveId(environment?.[key])
    if (id) return id
  }

  return null
}

export function getZendeskTicketDimensionFieldMap(environment = {}) {
  return Object.fromEntries(
    Object.entries(FIELD_ENVIRONMENT_KEYS).map(([dimension, keys]) => [
      dimension,
      firstConfiguredId(environment, keys)
    ])
  )
}

export function configuredTicketDimensionFieldCount(fieldMap = {}) {
  return Object.values(fieldMap).filter(Boolean).length
}

export function normalizeDimensionKey(value) {
  const candidate = Array.isArray(value)
    ? value.find(item => item !== null && item !== undefined && String(item).trim())
    : value

  if (candidate === null || candidate === undefined) return null

  const normalized = String(candidate)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_:.]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || null
}

function normalizedTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function customFieldValues(ticket) {
  const values = new Map()

  for (const field of Array.isArray(ticket?.custom_fields) ? ticket.custom_fields : []) {
    const id = positiveId(field?.id)
    if (id) values.set(id, field?.value)
  }

  return values
}

export function buildTicketDimensionProfile(ticket, fieldMap = {}) {
  const ticketId = positiveId(ticket?.id)
  if (!ticketId) return null

  const fields = customFieldValues(ticket)
  const appFieldId = positiveId(fieldMap?.app)
  const platformFieldId = positiveId(fieldMap?.platform)
  const countryFieldId = positiveId(fieldMap?.country)
  const concernFieldId = positiveId(fieldMap?.concern)

  return {
    ticket_id: ticketId,
    app_key: appFieldId ? normalizeDimensionKey(fields.get(appFieldId)) : null,
    platform_key: platformFieldId
      ? normalizeDimensionKey(fields.get(platformFieldId))
      : null,
    country_key: countryFieldId
      ? normalizeDimensionKey(fields.get(countryFieldId))
      : null,
    concern_key: concernFieldId
      ? normalizeDimensionKey(fields.get(concernFieldId))
      : null,
    source_updated_at: normalizedTimestamp(ticket?.updated_at ?? ticket?.created_at),
    source_system: 'zendesk',
    source_record_type: 'ticket',
    source_record_id: String(ticketId),
    profile_version: 'zendesk-custom-fields-v2',
    metadata: {
      status: normalizeDimensionKey(ticket?.status),
      configured_field_ids: {
        app: appFieldId,
        platform: platformFieldId,
        country: countryFieldId,
        concern: concernFieldId
      }
    }
  }
}

export function buildTicketDimensionProfiles(tickets, fieldMap = {}) {
  const profiles = new Map()

  for (const ticket of tickets || []) {
    const profile = buildTicketDimensionProfile(ticket, fieldMap)
    if (!profile) continue

    const existing = profiles.get(profile.ticket_id)
    if (
      !existing ||
      !existing.source_updated_at ||
      (profile.source_updated_at && profile.source_updated_at >= existing.source_updated_at)
    ) {
      profiles.set(profile.ticket_id, profile)
    }
  }

  return [...profiles.values()].sort((left, right) => left.ticket_id - right.ticket_id)
}
