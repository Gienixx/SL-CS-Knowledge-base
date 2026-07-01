import { getServiceHeaders } from './auth-header-helper.js'
import { fetchZendeskJson } from './zendesk-client.js'

const MAX_AGENT_BATCH = 100

async function supabaseRequest(environment, path, options = {}) {
  const response = await fetch(
    `${environment.supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        ...(options.headers || {})
      }
    }
  )
  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    const details = typeof data === 'string'
      ? data
      : data?.message || data?.details || JSON.stringify(data)
    throw new Error(
      `Supabase agent-directory request failed with status ` +
      `${response.status}: ${details}`
    )
  }

  return data
}

function positiveId(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function normalizeZendeskAgent(user, updatedAt = new Date().toISOString()) {
  const zendeskUserId = positiveId(user?.id)
  const agentName = typeof user?.name === 'string'
    ? user.name.replace(/\s+/g, ' ').trim()
    : ''

  if (!zendeskUserId || !agentName) return null

  return {
    agent_key: `zendesk:${zendeskUserId}`,
    zendesk_user_id: zendeskUserId,
    agent_name: agentName,
    active: user?.active !== false,
    role: typeof user?.role === 'string' && user.role.trim()
      ? user.role.trim().toLowerCase()
      : null,
    updated_at: updatedAt
  }
}

async function getUnresolvedAgentIds(environment) {
  const rows = await supabaseRequest(
    environment,
    'rpc/get_unresolved_zendesk_agent_ids',
    {
      method: 'POST',
      body: JSON.stringify({ p_limit: MAX_AGENT_BATCH })
    }
  )

  return [...new Set((Array.isArray(rows) ? rows : [])
    .map(row => positiveId(row?.zendesk_user_id))
    .filter(Boolean))]
}

async function upsertAgents(environment, agents) {
  if (agents.length === 0) return 0

  await supabaseRequest(
    environment,
    'zendesk_agent_directory?on_conflict=agent_key',
    {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(agents)
    }
  )

  return agents.length
}

export async function syncZendeskAgentDirectory(environment) {
  const agentIds = await getUnresolvedAgentIds(environment)
  if (agentIds.length === 0) return 0

  const payload = await fetchZendeskJson(
    environment,
    '/api/v2/users/show_many.json',
    { ids: agentIds.join(',') }
  )
  const updatedAt = new Date().toISOString()
  const agents = (Array.isArray(payload?.users) ? payload.users : [])
    .map(user => normalizeZendeskAgent(user, updatedAt))
    .filter(Boolean)

  return upsertAgents(environment, agents)
}
