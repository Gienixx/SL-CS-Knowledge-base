import {
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  refreshDailyOperationsMetrics
} from '../_shared/operations-metrics-store.js'

const DEFAULT_TIME_ZONE = 'America/New_York'
const DEFAULT_ROLLING_DAYS = 30
const MAX_DIAGNOSTIC_LENGTH = 500

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  })
}

function validDate(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Date values must use YYYY-MM-DD.')
  }

  const parsed = new Date(`${value}T00:00:00Z`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('Date value is invalid.')
  }

  return value
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )

  return `${values.year}-${values.month}-${values.day}`
}

async function readJson(request) {
  const text = await request.text()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function diagnosticFor(error) {
  const raw = String(
    error?.details || error?.message || 'Unknown refresh error.'
  )

  return {
    upstreamStatus: Number(error?.status) || null,
    details: raw.slice(0, MAX_DIAGNOSTIC_LENGTH)
  }
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return jsonResponse({
      success: false,
      code: 'operations_configuration_incomplete',
      error: error.message
    }, 503)
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )) {
    return jsonResponse({
      success: false,
      code: 'unauthorized',
      error: 'Unauthorized operations-metrics refresh request.'
    }, 401, { 'WWW-Authenticate': 'Bearer' })
  }

  try {
    const body = await readJson(context.request)
    const fullRefresh = body?.full === true
    const timeZone = typeof context.env?.OPERATIONS_TIME_ZONE === 'string' &&
      context.env.OPERATIONS_TIME_ZONE.trim()
      ? context.env.OPERATIONS_TIME_ZONE.trim()
      : DEFAULT_TIME_ZONE
    const now = new Date()
    const rollingStart = new Date(
      now.getTime() - DEFAULT_ROLLING_DAYS * 86400000
    )
    const startDate = fullRefresh
      ? null
      : validDate(body?.startDate) || dateInTimeZone(rollingStart, timeZone)
    const endDate = fullRefresh
      ? null
      : validDate(body?.endDate) || dateInTimeZone(now, timeZone)

    if (startDate && endDate && startDate > endDate) {
      return jsonResponse({
        success: false,
        code: 'invalid_date_range',
        error: 'startDate must be on or before endDate.'
      }, 400)
    }

    const result = await refreshDailyOperationsMetrics(environment, {
      startDate,
      endDate,
      timeZone
    })

    return jsonResponse({
      success: true,
      mode: fullRefresh ? 'full' : 'rolling',
      timeZone,
      startDate: result.refresh_start_date || startDate,
      endDate: result.refresh_end_date || endDate,
      rowsUpserted: Number(result.rows_upserted) || 0
    })
  } catch (error) {
    const diagnostic = diagnosticFor(error)

    console.error('Daily operations metrics refresh failed:', {
      upstreamStatus: diagnostic.upstreamStatus,
      details: diagnostic.details
    })

    return jsonResponse({
      success: false,
      code: 'operations_metrics_refresh_failed',
      error: 'Unable to refresh daily operations metrics.',
      diagnostic
    }, 500)
  }
}

export function onRequestGet() {
  return jsonResponse({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST for daily operations metrics refresh.'
  }, 405, { Allow: 'POST' })
}
