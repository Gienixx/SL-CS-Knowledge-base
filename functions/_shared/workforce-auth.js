import {
  createLegacyWorkforceAccess,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../../shared/workforce-access.js'

export class WorkforceAuthorizationError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'WorkforceAuthorizationError'
    this.status = status
  }
}

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return ''
  }

  return authorization.slice('Bearer '.length).trim()
}

function getRequiredEnvironment(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new WorkforceAuthorizationError(
      'Supabase environment variables are incomplete.',
      500
    )
  }

  return {
    supabaseUrl: SUPABASE_URL.endsWith('/')
      ? SUPABASE_URL.slice(0, -1)
      : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  }
}

async function parseResponse(response) {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function responseError(data, fallback) {
  if (data && typeof data === 'object') {
    return data.message || data.error || fallback
  }

  return typeof data === 'string' && data.trim()
    ? data
    : fallback
}

function isMissingAccessRpcResponse(response, data) {
  const code = String(data?.code || '').toUpperCase()
  const message = String(
    data?.message || data?.error || data || ''
  ).toLowerCase()

  return (
    response.status === 404 ||
    code === 'PGRST202' ||
    code === '42883' ||
    message.includes('workforce_get_current_access') &&
      (
        message.includes('not find') ||
        message.includes('does not exist') ||
        message.includes('schema cache')
      )
  )
}

async function authenticateUser(
  supabaseUrl,
  anonKey,
  accessToken
) {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  )

  const data = await parseResponse(response)

  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      'Your session is invalid or has expired.',
      401
    )
  }

  if (!normalizeEmail(data?.email)) {
    throw new WorkforceAuthorizationError(
      'The authenticated account has no email address.',
      401
    )
  }

  return data
}

async function loadRpcAccess(
  supabaseUrl,
  anonKey,
  accessToken,
  user
) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/workforce_get_current_access`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    }
  )

  const data = await parseResponse(response)

  if (!response.ok) {
    if (isMissingAccessRpcResponse(response, data)) {
      return null
    }

    throw new WorkforceAuthorizationError(
      responseError(data, 'Unable to load workforce permissions.'),
      response.status >= 400 && response.status < 600
        ? response.status
        : 500
    )
  }

  return data
    ? normalizeWorkforceAccess(data, { user })
    : null
}

async function loadLegacyAccess(
  supabaseUrl,
  serviceRoleKey,
  user
) {
  const email = normalizeEmail(user?.email)

  if (!email) {
    return createLegacyWorkforceAccess(null, { user })
  }

  const url = new URL(`${supabaseUrl}/rest/v1/login`)
  url.searchParams.set(
    'select',
    'name,email,is_admin,can_edit_articles'
  )
  url.searchParams.set('email', `eq.${email}`)
  url.searchParams.set('limit', '1')

  const response = await fetch(url.toString(), {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  })

  const data = await parseResponse(response)

  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      responseError(data, 'Unable to verify workforce permissions.'),
      500
    )
  }

  return createLegacyWorkforceAccess(
    Array.isArray(data) ? data[0] : null,
    { user }
  )
}

export async function loadWorkforceAuthorization(context) {
  const accessToken = getBearerToken(context.request)

  if (!accessToken) {
    throw new WorkforceAuthorizationError(
      'Authentication required.',
      401
    )
  }

  const environment = getRequiredEnvironment(context)
  const user = await authenticateUser(
    environment.supabaseUrl,
    environment.anonKey,
    accessToken
  )

  const rpcAccess = await loadRpcAccess(
    environment.supabaseUrl,
    environment.anonKey,
    accessToken,
    user
  )

  const access = rpcAccess || await loadLegacyAccess(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    user
  )

  if (!access.allowed) {
    throw new WorkforceAuthorizationError(
      'Your workforce account is inactive or unavailable.',
      403
    )
  }

  return {
    ...environment,
    accessToken,
    user,
    access
  }
}

export async function requireWorkforcePermission(
  context,
  permissionKey,
  {
    requireAdmin = false
  } = {}
) {
  const authorization = await loadWorkforceAuthorization(context)

  if (!hasWorkforcePermission(authorization.access, permissionKey)) {
    throw new WorkforceAuthorizationError(
      'You do not have the required workforce permission.',
      403
    )
  }

  if (requireAdmin && authorization.access.is_admin !== true) {
    throw new WorkforceAuthorizationError(
      'Administrator access required.',
      403
    )
  }

  return authorization
}
