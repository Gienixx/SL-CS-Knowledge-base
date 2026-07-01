import {
  fetchZendeskJson,
  getZendeskEnvironment
} from '../_shared/zendesk-client.js'

const MAX_AGENT_IDS = 100

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=300'
    }
  })
}

function bearerToken(request) {
  const authorization = request.headers.get('Authorization')
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function positiveId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function idFromAgentKey(value) {
  const match = String(value || '').match(/^zendesk:(\d+)$/)
  return match ? positiveId(match[1]) : null
}

async function parseJson(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function requireDashboardUser(context) {
  const accessToken = bearerToken(context.request)
  const supabaseUrl = String(context.env.SUPABASE_URL || '').replace(/\/$/, '')
  const anonKey = String(context.env.SUPABASE_ANON_KEY || '').trim()
  const serviceRoleKey = String(
    context.env.SUPABASE_SERVICE_ROLE_KEY || ''
  ).trim()

  if (!accessToken) {
    throw Object.assign(new Error('Authentication required.'), { status: 401 })
  }

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw Object.assign(
      new Error('Supabase environment variables are incomplete.'),
      { status: 500 }
    )
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`
    }
  })
  const user = await parseJson(userResponse)

  if (!userResponse.ok || !user?.email) {
    throw Object.assign(
      new Error('Your session is invalid or has expired.'),
      { status: 401 }
    )
  }

  const email = normalizeEmail(user.email)
  const permissionUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  permissionUrl.searchParams.set('select', 'email')
  permissionUrl.searchParams.set('email', `eq.${email}`)
  permissionUrl.searchParams.set('limit', '1')

  const permissionResponse = await fetch(permissionUrl, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  })
  const permissionRows = await parseJson(permissionResponse)

  if (
    !permissionResponse.ok ||
    !Array.isArray(permissionRows) ||
    permissionRows.length === 0
  ) {
    throw Object.assign(
      new Error('Dashboard access is not authorized.'),
      { status: 403 }
    )
  }
}

function requestedIds(body) {
  const keys = Array.isArray(body?.agentKeys) ? body.agentKeys : []
  const ids = keys.map(idFromAgentKey).filter(Boolean)

  return [...new Set(ids)].slice(0, MAX_AGENT_IDS)
}

export async function onRequestPost(context) {
  try {
    await requireDashboardUser(context)

    let body
    try {
      body = await context.request.json()
    } catch {
      return respond({ error: 'The request body must contain valid JSON.' }, 400)
    }

    const ids = requestedIds(body)
    if (ids.length === 0) {
      return respond({ agents: [] })
    }

    const environment = getZendeskEnvironment(context.env, {
      requireSyncSecret: false,
      requireSupabase: false
    })
    const payload = await fetchZendeskJson(
      environment,
      '/api/v2/users/show_many.json',
      { ids: ids.join(',') }
    )
    const requested = new Set(ids)
    const agents = (Array.isArray(payload?.users) ? payload.users : [])
      .map(user => {
        const id = positiveId(user?.id)
        const name = typeof user?.name === 'string'
          ? user.name.replace(/\s+/g, ' ').trim()
          : ''

        return id && requested.has(id) && name
          ? { agent_key: `zendesk:${id}`, agent_name: name }
          : null
      })
      .filter(Boolean)

    return respond({ agents })
  } catch (error) {
    console.error('Zendesk agent-name lookup failed:', error)
    return respond(
      { error: error?.message || 'Unable to resolve Zendesk agent names.' },
      Number.isInteger(error?.status) ? error.status : 500
    )
  }
}

export function onRequestGet() {
  return respond({ error: 'Use POST.' }, 405)
}
