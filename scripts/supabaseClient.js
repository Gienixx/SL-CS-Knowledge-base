import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = 'https://kfhyckyrgplkqhsbuwnx.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmaHlja3lyZ3Bsa3Foc2J1d254Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzQwMzAsImV4cCI6MjA5NzIxMDAzMH0.fx_VADGD6VWoRjV_Sk25rMVrVjWCiYugw2oYS2D8Rpo'

// Several pages load independent ES module entry points. Query-string cache
// versions can cause this module to be evaluated more than once, and multiple
// GoTrue clients competing for the same stored session can refresh a token
// immediately after another client signs out. Keep one browser-wide client.
export const supabase = window.__slSupabase || createClient(
  supabaseUrl,
  supabaseAnonKey
)

window.__slSupabase = supabase

export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

const SESSION_STARTED_AT_KEY = 'sl-cs-session-started-at'
let sessionExpiryTimer = null
let sessionExpiryInProgress = false

function decodeJwtPayload(accessToken) {
  try {
    const payload = String(accessToken || '').split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(window.atob(padded))
  } catch {
    return null
  }
}

function sessionIdentity(session) {
  const payload = decodeJwtPayload(session?.access_token)
  return payload?.session_id || session?.refresh_token || session?.user?.id || ''
}

function readSessionStart(session) {
  const identity = sessionIdentity(session)

  try {
    const stored = JSON.parse(window.localStorage.getItem(SESSION_STARTED_AT_KEY) || 'null')
    if (
      stored?.identity === identity &&
      Number.isFinite(stored?.startedAt)
    ) {
      return stored.startedAt
    }
  } catch {
    // Fall through to the authenticated session timestamps.
  }

  const lastSignInAt = Date.parse(session?.user?.last_sign_in_at || '')
  const payload = decodeJwtPayload(session?.access_token)
  const issuedAt = Number(payload?.iat) * 1000
  const startedAt = Number.isFinite(lastSignInAt)
    ? lastSignInAt
    : Number.isFinite(issuedAt) ? issuedAt : Date.now()

  writeSessionStart(session, startedAt)
  return startedAt
}

function writeSessionStart(session, startedAt = Date.now()) {
  const identity = sessionIdentity(session)
  if (!identity) return

  try {
    window.localStorage.setItem(SESSION_STARTED_AT_KEY, JSON.stringify({
      identity,
      startedAt
    }))
  } catch (error) {
    console.warn('Unable to persist the session start time:', error)
  }
}

function clearSessionStart() {
  try {
    window.localStorage.removeItem(SESSION_STARTED_AT_KEY)
  } catch (error) {
    console.warn('Unable to clear the session start time:', error)
  }
  if (sessionExpiryTimer) window.clearTimeout(sessionExpiryTimer)
  sessionExpiryTimer = null
}

function redirectToExpiredLogin() {
  const loginUrl = new URL('./login.html', window.location.href)
  loginUrl.searchParams.set('sessionExpired', '1')
  window.location.replace(loginUrl.href)
}

async function expireCurrentSession() {
  if (sessionExpiryInProgress) return true
  sessionExpiryInProgress = true

  try {
    clearSessionStart()
    await supabase.auth.signOut({ scope: 'local' })
  } catch (error) {
    console.error('Unable to complete automatic sign-out:', error)
  } finally {
    sessionExpiryInProgress = false
  }

  if (!/\/login\.html$/i.test(window.location.pathname)) {
    redirectToExpiredLogin()
  }

  return true
}

function scheduleSessionExpiry(session) {
  if (sessionExpiryTimer) window.clearTimeout(sessionExpiryTimer)

  const remaining = SESSION_MAX_AGE_MS - (Date.now() - readSessionStart(session))
  if (remaining <= 0) return expireCurrentSession()

  sessionExpiryTimer = window.setTimeout(
    () => expireCurrentSession(),
    remaining
  )
  return false
}

export function startSessionLifetime(session) {
  if (!session?.user) return
  writeSessionStart(session)
  scheduleSessionExpiry(session)
}

export async function enforceSessionLifetime() {
  const {
    data: { session },
    error
  } = await supabase.auth.getSession()

  if (error) throw error
  if (!session?.user) {
    clearSessionStart()
    return false
  }

  return scheduleSessionExpiry(session)
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || !session?.user) {
    clearSessionStart()
    return
  }

  scheduleSessionExpiry(session)
})

export const sessionLifetimeReady = enforceSessionLifetime().catch(error => {
  console.error('Unable to enforce the session lifetime:', error)
  return false
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void enforceSessionLifetime()
  }
})

window.addEventListener('focus', () => {
  void enforceSessionLifetime()
})

const FIRST_LOGIN_POLICY_START = Date.parse(
  '2026-06-20T16:00:00.000Z'
)

export function requiresFirstLoginPasswordChange(user) {
  if (!user) {
    return false
  }

  const metadata =
    user.user_metadata &&
    typeof user.user_metadata === 'object'
      ? user.user_metadata
      : {}

  if (
    metadata.password_change_completed === true ||
    metadata.requires_password_change === false ||
    Boolean(metadata.password_changed_at)
  ) {
    return false
  }

  const lastSignInAt = Date.parse(
    user.last_sign_in_at || ''
  )

  const updatedAt = Date.parse(
    user.updated_at || ''
  )

  if (
    Number.isFinite(lastSignInAt) &&
    Number.isFinite(updatedAt) &&
    updatedAt > lastSignInAt + 1000
  ) {
    return false
  }

  if (metadata.requires_password_change === true) {
    return true
  }

  const createdAt = Date.parse(user.created_at || '')

  return (
    Number.isFinite(createdAt) &&
    createdAt >= FIRST_LOGIN_POLICY_START
  )
}
