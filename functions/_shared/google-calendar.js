import { getServiceHeaders } from './auth-header-helper.js'

export const GOOGLE_CALENDAR_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

export function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null
  }

  return authorization.slice('Bearer '.length).trim()
}

export function getCoreEnvironment(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are incomplete.')
  }

  return {
    supabaseUrl: SUPABASE_URL.endsWith('/')
      ? SUPABASE_URL.slice(0, -1)
      : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  }
}

export function getGoogleEnvironment(context) {
  const core = getCoreEnvironment(context)
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALENDAR_REDIRECT_URI,
    GOOGLE_TOKEN_ENCRYPTION_KEY
  } = context.env

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_CALENDAR_REDIRECT_URI ||
    !GOOGLE_TOKEN_ENCRYPTION_KEY
  ) {
    throw new Error('Google Calendar environment variables are incomplete.')
  }

  return {
    ...core,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    googleRedirectUri: GOOGLE_CALENDAR_REDIRECT_URI,
    tokenEncryptionKey: GOOGLE_TOKEN_ENCRYPTION_KEY
  }
}

export function googleEnvironmentConfigured(context) {
  return Boolean(
    context.env.GOOGLE_CLIENT_ID &&
    context.env.GOOGLE_CLIENT_SECRET &&
    context.env.GOOGLE_CALENDAR_REDIRECT_URI &&
    context.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  )
}

export async function requireAuthorizedUser(context) {
  const accessToken = getBearerToken(context.request)

  if (!accessToken) {
    return {
      authorized: false,
      response: jsonResponse({ error: 'Authentication required.' }, 401)
    }
  }

  const environment = getCoreEnvironment(context)
  const userResponse = await fetch(
    `${environment.supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: environment.anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  )

  if (!userResponse.ok) {
    return {
      authorized: false,
      response: jsonResponse(
        { error: 'Your session is invalid or has expired.' },
        401
      )
    }
  }

  const user = await userResponse.json()
  const email = user.email?.trim().toLowerCase()

  if (!user.id || !email) {
    return {
      authorized: false,
      response: jsonResponse(
        { error: 'The authenticated account is incomplete.' },
        401
      )
    }
  }

  const loginUrl = new URL(`${environment.supabaseUrl}/rest/v1/login`)
  loginUrl.searchParams.set('select', 'email')
  loginUrl.searchParams.set('email', `eq.${email}`)
  loginUrl.searchParams.set('limit', '1')

  const loginResponse = await fetch(loginUrl, {
    headers: getServiceHeaders(environment.serviceRoleKey)
  })

  if (!loginResponse.ok) {
    console.error('Google Calendar access lookup failed:', await loginResponse.text())
    return {
      authorized: false,
      response: jsonResponse(
        { error: 'Unable to verify application access.' },
        500
      )
    }
  }

  const loginRows = await loginResponse.json()

  if (!Array.isArray(loginRows) || !loginRows.length) {
    return {
      authorized: false,
      response: jsonResponse(
        { error: 'Your account is not authorized for this application.' },
        403
      )
    }
  }

  return {
    authorized: true,
    accessToken,
    user: {
      id: user.id,
      email
    },
    environment
  }
}

export async function serviceRequest(
  environment,
  path,
  {
    method = 'GET',
    body,
    prefer,
    allowNotFound = false
  } = {}
) {
  const response = await fetch(
    `${environment.supabaseUrl}/rest/v1/${path}`,
    {
      method,
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  )

  const responseText = await response.text()
  let data = null

  if (responseText) {
    try {
      data = JSON.parse(responseText)
    } catch {
      data = responseText
    }
  }

  if (!response.ok && !(allowNotFound && response.status === 404)) {
    const detail = typeof data === 'object'
      ? data?.message || data?.error || JSON.stringify(data)
      : data
    throw new Error(detail || `Supabase request failed with ${response.status}.`)
  }

  return { response, data }
}

export async function getGoogleConnection(environment, userId) {
  const url = new URL(
    `${environment.supabaseUrl}/rest/v1/google_calendar_connections`
  )
  url.searchParams.set(
    'select',
    'user_id,encrypted_refresh_token,calendar_id,calendar_summary,calendar_timezone,granted_scope,connected_at,updated_at,last_synced_at,last_error'
  )
  url.searchParams.set('user_id', `eq.${userId}`)
  url.searchParams.set('limit', '1')

  const response = await fetch(url, {
    headers: getServiceHeaders(environment.serviceRoleKey)
  })

  if (!response.ok) {
    throw new Error(
      `Unable to read Google Calendar connection: ${await response.text()}`
    )
  }

  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : null
}

export async function patchGoogleConnection(
  environment,
  userId,
  values
) {
  const path = `google_calendar_connections?user_id=eq.${encodeURIComponent(userId)}`
  await serviceRequest(environment, path, {
    method: 'PATCH',
    body: {
      ...values,
      updated_at: new Date().toISOString()
    },
    prefer: 'return=minimal'
  })
}

export function createRandomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export async function hashState(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(value)
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function encryptSecret(value, rawKey) {
  if (typeof value !== 'string' || !value) {
    throw new Error('A non-empty secret is required for encryption.')
  }

  const key = await importEncryptionKey(rawKey, ['encrypt'])
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(value)
  )

  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptSecret(value, rawKey) {
  const [version, ivValue, ciphertextValue] = String(value || '').split('.')

  if (version !== 'v1' || !ivValue || !ciphertextValue) {
    throw new Error('The stored Google Calendar token has an invalid format.')
  }

  const key = await importEncryptionKey(rawKey, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlToBytes(ivValue)
    },
    key,
    base64UrlToBytes(ciphertextValue)
  )

  return textDecoder.decode(plaintext)
}

async function importEncryptionKey(rawKey, usages) {
  const keyBytes = base64UrlToBytes(rawKey)

  if (keyBytes.byteLength !== 32) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.'
    )
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    usages
  )
}

export function buildGoogleAuthorizationUrl(environment, state, loginHint = '') {
  const authorizationUrl = new URL(
    'https://accounts.google.com/o/oauth2/v2/auth'
  )
  authorizationUrl.searchParams.set('client_id', environment.googleClientId)
  authorizationUrl.searchParams.set('redirect_uri', environment.googleRedirectUri)
  authorizationUrl.searchParams.set('response_type', 'code')
  authorizationUrl.searchParams.set('scope', GOOGLE_CALENDAR_READONLY_SCOPE)
  authorizationUrl.searchParams.set('access_type', 'offline')
  authorizationUrl.searchParams.set('include_granted_scopes', 'true')
  authorizationUrl.searchParams.set('prompt', 'consent select_account')
  authorizationUrl.searchParams.set('state', state)

  if (loginHint) {
    authorizationUrl.searchParams.set('login_hint', loginHint)
  }

  return authorizationUrl.toString()
}

export async function exchangeGoogleAuthorizationCode(environment, code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      code,
      client_id: environment.googleClientId,
      client_secret: environment.googleClientSecret,
      redirect_uri: environment.googleRedirectUri,
      grant_type: 'authorization_code'
    })
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(
      data.error_description || data.error || 'Google authorization failed.'
    )
  }

  return data
}

export async function refreshGoogleAccessToken(environment, refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: environment.googleClientId,
      client_secret: environment.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })

  const data = await response.json()

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || 'Google access could not be refreshed.'
    )
  }

  return data.access_token
}

export async function googleApiRequest(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`
    }
  })

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
    const message = typeof data === 'object'
      ? data?.error?.message || data?.error_description || data?.error
      : data
    throw new Error(message || `Google API request failed with ${response.status}.`)
  }

  return data
}

export function safeReturnTo(value) {
  return value === './home.html' || value === '/home.html'
    ? '/home.html'
    : '/home.html'
}

export function redirectWithResult(request, returnTo, values) {
  const requestUrl = new URL(request.url)
  const destination = new URL(safeReturnTo(returnTo), requestUrl.origin)

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      destination.searchParams.set(key, String(value))
    }
  }

  return Response.redirect(destination.toString(), 302)
}

function bytesToBase64Url(bytes) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - normalized.length % 4) % 4),
    '='
  )
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
