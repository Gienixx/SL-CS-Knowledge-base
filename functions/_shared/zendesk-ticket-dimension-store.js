import { getServiceHeaders } from './auth-header-helper.js'

const PROFILE_BATCH_SIZE = 100

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
  const body = await response.text()
  let data = null

  if (body) {
    try {
      data = JSON.parse(body)
    } catch {
      data = body
    }
  }

  if (!response.ok) {
    const details = typeof data === 'string'
      ? data
      : data?.message || data?.details || JSON.stringify(data)
    throw new Error(
      `Supabase ticket-dimension request failed with status ${response.status}: ${details}`
    )
  }

  return data
}

export async function upsertTicketDimensionProfiles(environment, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) return 0

  let affected = 0

  for (let start = 0; start < profiles.length; start += PROFILE_BATCH_SIZE) {
    const batch = profiles.slice(start, start + PROFILE_BATCH_SIZE)
    const result = await supabaseRequest(
      environment,
      'rpc/upsert_ticket_dimension_profiles',
      {
        method: 'POST',
        body: JSON.stringify({ p_profiles: batch })
      }
    )

    const count = Number(result)
    if (!Number.isFinite(count) || count < 0) {
      throw new Error('Supabase returned an invalid ticket-dimension upsert count.')
    }

    affected += count
  }

  return affected
}
