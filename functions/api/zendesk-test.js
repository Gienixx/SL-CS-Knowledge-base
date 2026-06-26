import {
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch,
  testZendeskConnection,
  ZendeskApiError
} from '../_shared/zendesk-client.js'
import {
  getServiceHeaders
} from '../_shared/auth-header-helper.js'

function jsonResponse(data, status = 200, additionalHeaders = {}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...additionalHeaders
      }
    }
  )
}

async function testSupabaseConnection(environment, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${environment.supabaseUrl}/rest/v1/sheet_sync_runs?select=id&limit=1`,
    {
      method: 'HEAD',
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        Prefer: 'count=exact'
      }
    }
  )

  if (!response.ok) {
    throw new Error(
      `Supabase service-role verification failed with status ${response.status}.`
    )
  }

  return true
}

function publicError(error) {
  if (error instanceof ZendeskApiError) {
    if (error.status === 401) {
      return {
        status: 502,
        code: error.code,
        message: 'Zendesk rejected the configured credentials.'
      }
    }

    if (error.status === 403) {
      return {
        status: 502,
        code: error.code,
        message: 'The Zendesk integration user lacks a required permission.'
      }
    }

    if (error.status === 429) {
      return {
        status: 503,
        code: error.code,
        message: 'Zendesk temporarily rate-limited the connection test.'
      }
    }

    return {
      status: 502,
      code: error.code,
      message: 'Zendesk could not complete the connection test.'
    }
  }

  return {
    status: 500,
    code: 'zendesk_integration_test_failed',
    message: error?.message || 'Unable to test the Zendesk integration.'
  }
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        code: 'zendesk_configuration_incomplete',
        error: error.message
      },
      503
    )
  }

  const authorized = await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )

  if (!authorized) {
    return jsonResponse(
      {
        success: false,
        code: 'unauthorized',
        error: 'Unauthorized Zendesk integration test request.'
      },
      401,
      { 'WWW-Authenticate': 'Bearer' }
    )
  }

  try {
    const [zendesk, supabaseConnected] = await Promise.all([
      testZendeskConnection(environment),
      testSupabaseConnection(environment)
    ])

    return jsonResponse({
      success: true,
      integration: 'zendesk',
      supabaseConnected,
      ...zendesk
    })
  } catch (error) {
    const safeError = publicError(error)

    console.error('Zendesk integration test failed:', {
      code: safeError.code,
      status: error?.status || safeError.status,
      message: error?.message || safeError.message
    })

    return jsonResponse(
      {
        success: false,
        code: safeError.code,
        error: safeError.message
      },
      safeError.status
    )
  }
}

export function onRequestGet() {
  return jsonResponse(
    {
      success: false,
      code: 'method_not_allowed',
      error: 'Use POST for the Zendesk integration test.'
    },
    405,
    { Allow: 'POST' }
  )
}
