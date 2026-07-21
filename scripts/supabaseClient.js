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
