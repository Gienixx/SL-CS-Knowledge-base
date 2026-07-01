const FIELD_ENVIRONMENT_NAMES = Object.freeze({
  app_key: 'ZENDESK_APP_FIELD_ID',
  platform_key: 'ZENDESK_PLATFORM_FIELD_ID',
  country_key: 'ZENDESK_COUNTRY_FIELD_ID',
  driver_key: 'ZENDESK_DRIVER_FIELD_ID'
})

const COUNTRY_ALIASES = Object.freeze({
  australia: 'au',
  canada: 'ca',
  france: 'fr',
  germany: 'de',
  united_kingdom: 'gb',
  uk: 'gb',
  great_britain: 'gb',
  united_states: 'us',
  united_states_of_america: 'us',
  usa: 'us'
})

const PLATFORM_ALIASES = Object.freeze({
  iphone: 'ios',
  ipad: 'ios',
  apple: 'ios',
  google_play: 'android'
})

const APP_ALIASES = Object.freeze({
  eurekasurveys: 'eureka',
  survey_pop_app: 'survey_pop',
  surveypop: 'survey_pop',
  survey_spin_app: 'survey_spin',
  surveyspin: 'survey_spin'
})

function positiveId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function firstValue(value) {
  if (Array.isArray(value)) {
    return value.find(item =>
      item !== null &&
      item !== undefined &&
      String(item).trim()
    )
  }

  return value
}

export function normalizeDimensionKey(value) {
  const raw = firstValue(value)

  if (raw === null || raw === undefined) return null

  const normalized = String(raw)
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || null
}

function aliasKey(dimension, value) {
  const normalized = normalizeDimensionKey(value)
  if (!normalized) return null

  if (dimension === 'country_key') {
    return COUNTRY_ALIASES[normalized] || normalized
  }

  if (dimension === 'platform_key') {
    return PLATFORM_ALIASES[normalized] || normalized
  }

  if (dimension === 'app_key') {
    return APP_ALIASES[normalized] || normalized
  }

  return normalized
}

export function getZendeskTicketFieldMap(environment = {}) {
  return Object.fromEntries(
    Object.entries(FIELD_ENVIRONMENT_NAMES).map(([dimension, name]) => [
      dimension,
      positiveId(environment?.[name])
    ])
  )
}

function customFieldValues(ticket) {
  const values = new Map()

  for (const field of ticket?.custom_fields || []) {
    const id = positiveId(field?.id)
    if (id) values.set(id, field?.value)
  }

  return values
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function agentKey(value) {
  const id = positiveId(value)
  return id ? `zendesk:${id}` : null
}

export function buildTicketDimensionProfile(ticket, environment = {}) {
  const ticketId = positiveId(ticket?.id)
  if (!ticketId) return null

  const fieldMap = getZendeskTicketFieldMap(environment)
  const values = customFieldValues(ticket)
  const dimensions = {}

  for (const [dimension, fieldId] of Object.entries(fieldMap)) {
    dimensions[dimension] = fieldId
      ? aliasKey(dimension, values.get(fieldId))
      : null
  }

  return {
    ticket_id: ticketId,
    agent_key: agentKey(ticket?.assignee_id),
    app_key: dimensions.app_key,
    platform_key: dimensions.platform_key,
    country_key: dimensions.country_key,
    driver_key: dimensions.driver_key,
    priority: normalizeDimensionKey(ticket?.priority),
    channel: normalizeDimensionKey(ticket?.via?.channel),
    source_system: 'zendesk',
    source_updated_at: timestamp(ticket?.updated_at || ticket?.created_at)
  }
}

export function buildTicketDimensionProfiles(tickets, environment = {}) {
  if (!Array.isArray(tickets)) return []

  const profiles = new Map()

  for (const ticket of tickets) {
    const profile = buildTicketDimensionProfile(ticket, environment)
    if (profile) profiles.set(profile.ticket_id, profile)
  }

  return [...profiles.values()]
}
