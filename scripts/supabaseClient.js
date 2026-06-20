import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = 'https://kfhyckyrgplkqhsbuwnx.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzImZlZiI6ImtmaHlja3lyZ3Bsa3Foc2J1d254Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzQwMzAsImV4cCI6MjA5NzIxMDAzMH0.fx_VADGD6VWoRjV_Sk25rMVrVjWCiYugw2oYS2D8Rpo'

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
)

const FIRST_LOGIN_POLICY_START = Date.parse(
  '2026-06-21T00:00:00.000Z'
)

export function requiresFirstLoginPasswordChange(user) {
  if (!user) {
    return false
  }

  if (
    user.user_metadata
      ?.password_change_completed === true
  ) {
    return false
  }

  const createdAt = Date.parse(user.created_at || '')

  return (
    Number.isFinite(createdAt) &&
    createdAt >= FIRST_LOGIN_POLICY_START
  )
}

function isPasswordFlowPage() {
  const pageName = window.location.pathname
    .split('/')
    .pop()
    .toLowerCase()

  return (
    pageName === 'login.html' ||
    pageName === 'change-password.html'
  )
}

async function enforceFirstLoginPasswordChange() {
  if (isPasswordFlowPage()) {
    return
  }

  const {
    data: { user }
  } = await supabase.auth.getUser()

  if (!requiresFirstLoginPasswordChange(user)) {
    return
  }

  const passwordPage = new URL(
    './change-password.html?firstLogin=1',
    window.location.href
  )

  window.location.replace(passwordPage.href)
}

enforceFirstLoginPasswordChange().catch(error => {
  console.error(
    'First-login password check failed:',
    error
  )
})
