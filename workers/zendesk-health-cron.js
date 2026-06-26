function requiredEnvironment(env, name) {
  const value = typeof env?.[name] === 'string'
    ? env[name].trim()
    : ''

  if (!value) {
    throw new Error(`Missing required Worker environment value: ${name}.`)
  }

  return value
}

export function getEasternHour(date) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23'
    }
  ).formatToParts(date)

  return Number(parts.find(part => part.type === 'hour')?.value)
}

export function shouldRunZendeskHealthCheck(date) {
  return getEasternHour(date) === 12
}

export async function runZendeskHealthCheck(env, fetchImpl = fetch) {
  const pagesBaseUrl = requiredEnvironment(env, 'PAGES_BASE_URL')
  const syncSecret = requiredEnvironment(env, 'ZENDESK_SYNC_SECRET')
  const endpoint = new URL('/api/zendesk-test', pagesBaseUrl)
  const response = await fetchImpl(endpoint.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${syncSecret}`
    }
  })
  const responseText = await response.text()
  let payload = null

  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }

  if (!response.ok || payload?.success !== true) {
    throw new Error(
      `Zendesk health check failed with status ${response.status}.`
    )
  }

  console.log(JSON.stringify({
    event: 'zendesk_health_check',
    checkedAt: payload.checkedAt || new Date().toISOString(),
    supabaseConnected: payload.supabaseConnected === true,
    readyForTicketEventImport: payload.readyForTicketEventImport === true,
    readyForSlaImport: payload.readyForSlaImport === true,
    readyForCsatImport: payload.readyForCsatImport === true
  }))

  return payload
}

export default {
  async scheduled(controller, env, context) {
    const scheduledDate = new Date(controller.scheduledTime)

    if (!shouldRunZendeskHealthCheck(scheduledDate)) return

    context.waitUntil(runZendeskHealthCheck(env))
  },

  async fetch() {
    return new Response('Zendesk health cron is active.', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    })
  }
}
