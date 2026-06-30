import {
  getServiceHeaders
} from './auth-header-helper.js'

function parseResponse(text) {
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function refreshDailyOperationsMetrics(
  environment,
  {
    startDate = null,
    endDate = null,
    timeZone = 'America/New_York',
    fetchImpl = fetch
  } = {}
) {
  const response = await fetchImpl(
    `${environment.supabaseUrl}/rest/v1/rpc/refresh_daily_operations_metrics`,
    {
      method: 'POST',
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_start_date: startDate,
        p_end_date: endDate,
        p_time_zone: timeZone
      })
    }
  )
  const text = await response.text()
  const data = parseResponse(text)

  if (!response.ok) {
    const details = typeof data === 'string'
      ? data
      : data?.message || data?.details || JSON.stringify(data)
    const error = new Error(
      `Daily operations refresh failed with status ${response.status}: ${details}`
    )
    error.status = response.status
    error.details = details
    throw error
  }

  return Array.isArray(data) ? data[0] || {} : data || {}
}
